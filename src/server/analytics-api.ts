import { z } from "zod";
import { AuditService } from "@/server/features/audit/services/AuditService";
import {
  GSC_DIMENSIONS,
  GSC_SEARCH_TYPES,
} from "@/server/features/gsc/searchAnalytics";
import { GscService } from "@/server/features/gsc/services/GscService";
import { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { getLatestResults } from "@/server/features/rank-tracking/services/rankTrackingResults";
import {
  ANALYTICS_WEBHOOK_EVENTS,
  createAnalyticsWebhookSubscription,
  emitAnalyticsWebhook,
} from "@/server/analytics-webhooks";

const VISAGYAN_PROJECT_ID = "d3eb4c60-adac-4d32-81d1-0bd0014d8409";
const API_PREFIX = "/api/v1/projects/";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dimensionSchema = z.enum(GSC_DIMENSIONS);
const performanceQuerySchema = z
  .object({
    startDate: dateSchema.optional(),
    endDate: dateSchema.optional(),
    dimensions: z.string().default("query"),
    dataState: z.enum(["hourly_all", "all", "final"]).default("all"),
    type: z.enum(GSC_SEARCH_TYPES).default("web"),
    limit: z.coerce.number().int().min(1).max(1000).default(1000),
    cursor: z.coerce.number().int().min(0).default(0),
  })
  .refine((value) => Boolean(value.startDate) === Boolean(value.endDate), {
    message: "startDate and endDate must be provided together",
  });

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const expected = env.ANALYTICS_API_TOKEN;
  if (!expected) return false;
  const authorization = request.headers.get("authorization") ?? "";
  const received = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (!received) return false;
  const [expectedHash, receivedHash] = await Promise.all([
    digest(expected),
    digest(received),
  ]);
  return expectedHash === receivedHash;
}

function parseRoute(pathname: string): {
  projectId: string;
  resource: string[];
} | null {
  if (!pathname.startsWith(API_PREFIX)) return null;
  const segments = pathname.slice(API_PREFIX.length).split("/").filter(Boolean);
  const [projectId, ...resource] = segments;
  return projectId ? { projectId, resource } : null;
}

function freshThroughEndDate(endDate: string): string {
  return `${endDate}T23:59:59.999-07:00`;
}

async function searchConsolePerformance(url: URL): Promise<Response> {
  const parsed = performanceQuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsed.success) {
    return json(
      { error: "invalid_query", issues: parsed.error.flatten().fieldErrors },
      400,
    );
  }
  const dimensions = parsed.data.dimensions
    .split(",")
    .map((value) => value.trim())
    .flatMap((value) => {
      const dimension = dimensionSchema.safeParse(value);
      return dimension.success ? [dimension.data] : [];
    });
  if (dimensions.length === 0 || dimensions.length > 4) {
    return json({ error: "dimensions must contain 1–4 supported values" }, 400);
  }
  const result = await GscService.getPerformance({
    projectId: VISAGYAN_PROJECT_ID,
    dimensions,
    startDate: parsed.data.startDate,
    endDate: parsed.data.endDate,
    dataState: parsed.data.dataState,
    type: parsed.data.type,
    rowLimit: parsed.data.limit,
    startRow: parsed.data.cursor,
  });
  const observedAt = new Date().toISOString();
  const hasMore = result.rows.length === parsed.data.limit;
  return json({
    projectId: VISAGYAN_PROJECT_ID,
    siteUrl: result.siteUrl,
    dimensions,
    dataState: parsed.data.dataState === "final" ? "final" : "fresh_partial",
    sourceDataState: parsed.data.dataState,
    sourceObservedAt: observedAt,
    freshThrough: freshThroughEndDate(result.request.endDate),
    rows: result.rows,
    pagination: {
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
      hasMore,
      nextCursor: hasMore
        ? String(parsed.data.cursor + result.rows.length)
        : null,
    },
  });
}

async function rankSnapshots(trackerId: string, url: URL): Promise<Response> {
  const compare = z.enum(["1d", "7d", "30d", "90d"]).catch("7d").parse(
    url.searchParams.get("compare") ?? "7d",
  );
  const config = await RankTrackingRepository.getConfigById({
    configId: trackerId,
    projectId: VISAGYAN_PROJECT_ID,
  });
  if (!config) return json({ error: "tracker_not_found" }, 404);
  const results = await getLatestResults(
    trackerId,
    VISAGYAN_PROJECT_ID,
    compare,
  );
  return json({
    projectId: VISAGYAN_PROJECT_ID,
    tracker: config,
    results,
    sourceObservedAt: results.run?.lastCheckedAt ?? new Date().toISOString(),
    freshThrough: results.run?.lastCheckedAt ?? null,
    dataState: results.run ? "final" : "stale",
  });
}

async function latestAudit(): Promise<Response> {
  const history = await AuditService.getHistory(VISAGYAN_PROJECT_ID);
  const latest = history[0];
  if (!latest) {
    return json({
      projectId: VISAGYAN_PROJECT_ID,
      audit: null,
      sourceObservedAt: null,
      freshThrough: null,
      dataState: "stale",
    });
  }
  const results = await AuditService.getResults(
    latest.id,
    VISAGYAN_PROJECT_ID,
  );
  const observedAt = latest.completedAt ?? latest.startedAt;
  return json({
    projectId: VISAGYAN_PROJECT_ID,
    ...results,
    sourceObservedAt: observedAt,
    freshThrough: observedAt,
    dataState: latest.status === "completed" ? "final" : "fresh_partial",
  });
}

async function inspectUrls(url: URL, env: Env): Promise<Response> {
  const urls = url.searchParams
    .getAll("url")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const parsed = z.array(z.string().url()).min(1).max(20).safeParse(urls);
  if (!parsed.success) {
    return json({ error: "Provide 1–20 canonical URLs using ?url=" }, 400);
  }
  const result = await GscService.inspectUrls({
    projectId: VISAGYAN_PROJECT_ID,
    urls: parsed.data,
    languageCode: url.searchParams.get("languageCode") ?? "en-IN",
  });
  const observedAt = new Date().toISOString();
  await emitAnalyticsWebhook(env, {
    projectId: VISAGYAN_PROJECT_ID,
    type: "url_inspection.updated",
    entityType: "url_inspection",
    entityId: crypto.randomUUID(),
    sourceObservedAt: observedAt,
    dataState: "live",
    data: { results: result.results },
  });
  return json({
    projectId: VISAGYAN_PROJECT_ID,
    ...result,
    sourceObservedAt: observedAt,
    freshThrough: observedAt,
    dataState: "live",
  });
}

async function createWebhookSubscription(
  request: Request,
  env: Env,
): Promise<Response> {
  const schema = z.object({
    url: z.string().url(),
    events: z.array(z.enum(ANALYTICS_WEBHOOK_EVENTS)).min(1).max(4),
  });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return json(
      { error: "invalid_body", issues: parsed.error.flatten().fieldErrors },
      400,
    );
  }
  try {
    const subscription = await createAnalyticsWebhookSubscription(env, {
      projectId: VISAGYAN_PROJECT_ID,
      ...parsed.data,
    });
    return json(subscription, 201);
  } catch (error) {
    return json(
      {
        error: "subscription_rejected",
        message: error instanceof Error ? error.message : "Invalid subscription",
      },
      409,
    );
  }
}

async function keywords(url: URL): Promise<Response> {
  const page = z.coerce.number().int().min(1).catch(1).parse(
    url.searchParams.get("page") ?? 1,
  );
  const pageSize = z.coerce.number().int().min(1).max(1000).catch(250).parse(
    url.searchParams.get("pageSize") ?? 250,
  );
  const result = await KeywordResearchRepository.listSavedKeywordsByProject({
    projectId: VISAGYAN_PROJECT_ID,
    page,
    pageSize,
    search: url.searchParams.get("search") ?? undefined,
    sort: "createdAt",
    order: "desc",
  });
  const observedAt = new Date().toISOString();
  return json({
    projectId: VISAGYAN_PROJECT_ID,
    rows: result.rows,
    pagination: {
      page,
      pageSize,
      totalCount: result.totalCount,
      hasMore: page * pageSize < result.totalCount,
    },
    sourceObservedAt: observedAt,
    freshThrough: observedAt,
    dataState: "final",
  });
}

export async function handleAnalyticsApiRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return json({ error: "unauthorized" }, 401);
  }
  const url = new URL(request.url);
  const route = parseRoute(url.pathname);
  if (!route) return json({ error: "not_found" }, 404);
  if (route.projectId !== VISAGYAN_PROJECT_ID) {
    return json({ error: "project_not_allowed" }, 403);
  }
  const path = route.resource.join("/");
  if (request.method === "POST" && path === "webhook-subscriptions") {
    return createWebhookSubscription(request, env);
  }
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  try {
    if (path === "search-console/performance") {
      return await searchConsolePerformance(url);
    }
    if (
      route.resource[0] === "rank-trackers" &&
      route.resource[1] &&
      route.resource[2] === "snapshots"
    ) {
      return await rankSnapshots(route.resource[1], url);
    }
    if (path === "audits/latest") return await latestAudit();
    if (path === "url-inspections") return await inspectUrls(url, env);
    if (path === "keywords") return await keywords(url);
    return json({ error: "not_found" }, 404);
  } catch (error) {
    console.error("Analytics API request failed", error);
    await emitAnalyticsWebhook(env, {
      projectId: VISAGYAN_PROJECT_ID,
      type: "integration.degraded",
      entityType: "integration",
      entityId: "openseo",
      dataState: "stale",
      data: {
        path,
        error:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Unknown upstream error",
      },
    });
    return json(
      {
        error: "upstream_error",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      502,
    );
  }
}
