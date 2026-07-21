const SUBSCRIPTION_PREFIX = "analytics:webhook-subscription:";

export const ANALYTICS_WEBHOOK_EVENTS = [
  "rank_snapshot.completed",
  "audit.completed",
  "url_inspection.updated",
  "integration.degraded",
] as const;

export type AnalyticsWebhookEvent =
  (typeof ANALYTICS_WEBHOOK_EVENTS)[number];

export type AnalyticsWebhookSubscription = {
  id: string;
  projectId: string;
  url: string;
  events: AnalyticsWebhookEvent[];
  secret: string;
  createdAt: string;
};

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

function isSafeWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const privateIpv4 =
      /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(
        hostname,
      );
    return (
      url.protocol === "https:" &&
      !privateIpv4 &&
      hostname !== "localhost" &&
      hostname !== "127.0.0.1" &&
      hostname !== "::1" &&
      !hostname.endsWith(".local") &&
      !hostname.endsWith(".internal")
    );
  } catch {
    return false;
  }
}

export async function createAnalyticsWebhookSubscription(
  env: Env,
  input: {
    projectId: string;
    url: string;
    events: AnalyticsWebhookEvent[];
  },
): Promise<AnalyticsWebhookSubscription> {
  if (!isSafeWebhookUrl(input.url)) {
    throw new Error("Webhook URL must be a public HTTPS endpoint");
  }
  const existing = await env.KV.list({ prefix: SUBSCRIPTION_PREFIX, limit: 20 });
  if (existing.keys.length >= 20) {
    throw new Error("Webhook subscription limit reached");
  }
  const subscription: AnalyticsWebhookSubscription = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    url: input.url,
    events: [...new Set(input.events)],
    secret: randomSecret(),
    createdAt: new Date().toISOString(),
  };
  await env.KV.put(
    `${SUBSCRIPTION_PREFIX}${subscription.id}`,
    JSON.stringify(subscription),
  );
  return subscription;
}

async function signature(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return bytesToHex(new Uint8Array(signed));
}

async function deliver(
  subscription: AnalyticsWebhookSubscription,
  eventId: string,
  body: string,
): Promise<void> {
  let lastStatus: number | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(subscription.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-event-id": eventId,
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": `sha256=${await signature(subscription.secret, timestamp, body)}`,
      },
      body,
    }).catch(() => null);
    if (response?.ok) return;
    lastStatus = response?.status ?? null;
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 250 * 4 ** attempt));
    }
  }
  throw new Error(
    `Analytics webhook ${subscription.id} failed after retries (status=${lastStatus ?? "network"})`,
  );
}

export async function emitAnalyticsWebhook(
  env: Env,
  input: {
    projectId: string;
    type: AnalyticsWebhookEvent;
    entityType: string;
    entityId: string;
    sourceObservedAt?: string;
    dataState?: "live" | "fresh_partial" | "final" | "stale";
    data: Record<string, unknown>;
  },
): Promise<void> {
  const listed = await env.KV.list({ prefix: SUBSCRIPTION_PREFIX, limit: 100 });
  const subscriptions = await Promise.all(
    listed.keys.map((key) =>
      env.KV.get<AnalyticsWebhookSubscription>(key.name, "json"),
    ),
  );
  const observedAt = input.sourceObservedAt ?? new Date().toISOString();
  const eventId = crypto.randomUUID();
  const body = JSON.stringify({
    version: 1,
    type: input.type,
    entityType: input.entityType,
    entityId: input.entityId,
    sourceObservedAt: observedAt,
    freshThrough: observedAt,
    dataState: input.dataState ?? "final",
    data: input.data,
  });
  const targets = subscriptions.filter(
    (subscription): subscription is AnalyticsWebhookSubscription =>
      Boolean(
        subscription &&
          subscription.projectId === input.projectId &&
          subscription.events.includes(input.type),
      ),
  );
  const deliveries = await Promise.allSettled(
    targets.map((subscription) => deliver(subscription, eventId, body)),
  );
  const failed = deliveries.filter((result) => result.status === "rejected");
  if (failed.length > 0) {
    console.error(`${failed.length} analytics webhook delivery(s) failed`);
  }
}
