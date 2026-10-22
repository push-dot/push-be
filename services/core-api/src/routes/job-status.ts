import { one } from "../db.ts";
import { HttpError, data, requireUuid } from "../http.ts";
import { checkBackpressure } from "../jobs/backpressure.ts";
import { queueFor, type JobType, type Plan } from "../jobs/config.ts";
import { enqueueJob, kickDispatcher, withDispatcher } from "../jobs/enqueue.ts";
import { ts } from "../page.ts";
import type { Ctx } from "../types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const planTier = (value: unknown): Plan => {
  const raw = value == null ? "" : String(value).trim().toUpperCase();
  if (raw === "BASIC" || raw === "PRO" || raw === "ULTRA" || raw === "FREE") return raw;
  return "FREE";
};

const readObject = async (request: Request): Promise<Record<string, unknown>> => {
  const raw = await request.text();
  if (!raw) return {};
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, "VALIDATION_ERROR", "invalid request body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
  return body as Record<string, unknown>;
};

const notFound = (): HttpError => new HttpError(404, "NOT_FOUND", "resource not found");

const acceptJob = async (ctx: Ctx, type: JobType, payload: Record<string, unknown>): Promise<Response> => {
  const plan = planTier(ctx.user.plan);
  const queue = queueFor(type, plan, "PERSONAL");
  const pressure = await checkBackpressure(ctx.deps.query, queue, plan);
  if (!pressure.ok) {
    throw new HttpError(429, "QUEUE_BUSY", "queue is busy", { retryAfterSec: pressure.retryAfterSec });
  }
  const key = (ctx.request.headers.get("idempotency-key") || "").trim();
  const { jobId } = await enqueueJob(ctx.deps.query, {
    type,
    userId: ctx.user.id,
    plan,
    payload,
    idempotencyKey: key ? type + ":" + key : undefined,
    byok: false,
  });
  await withDispatcher(ctx.env, ctx.deps.fetch ?? fetch, () => kickDispatcher(queue));
  return data(202, { jobId }, ctx.rid);
};

export const getQueueJob = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const row = await one(
    ctx.deps.query,
    "SELECT id, type, status, result, error, payload, created_at, updated_at FROM ai_jobs WHERE id = $1 AND (user_id = $2 OR (company_id IS NOT NULL AND company_id = (SELECT company_id FROM company_members WHERE user_id = $2)))",
    [id, ctx.user.id],
  );
  if (!row) throw notFound();
  const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
  return data(200, {
    id: String(row.id),
    type: String(row.type),
    status: String(row.status),
    progress: payload.progress ?? null,
    result: row.result ?? null,
    error: row.error ?? null,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
  }, ctx.rid);
};

export const enqueueFit = async (ctx: Ctx, postingIdRaw: string): Promise<Response> => {
  const postingId = requireUuid(postingIdRaw, "id");
  const body = await readObject(ctx.request);
  const documentId = requireUuid(String(body.documentId ?? ""), "documentId");
  const owned = await one(
    ctx.deps.query,
    "SELECT d.id FROM documents d JOIN job_postings p ON p.id = $2 WHERE d.id = $1 AND d.user_id = $3",
    [documentId, postingId, ctx.user.id],
  );
  if (!owned) throw notFound();
  return acceptJob(ctx, "fit", { postingId, documentId });
};

export const enqueueDocumentGenerate = async (ctx: Ctx, documentIdRaw: string): Promise<Response> => {
  const documentId = requireUuid(documentIdRaw, "id");
  const body = await readObject(ctx.request);
  if (!Number.isInteger(body.expectedRevision)) {
    throw new HttpError(400, "VALIDATION_ERROR", "must be an integer", { field: "expectedRevision" });
  }
  const evidence = body.evidenceIds ?? [];
  if (!Array.isArray(evidence) || evidence.some((v) => typeof v !== "string" || !UUID_RE.test(v))) {
    throw new HttpError(400, "VALIDATION_ERROR", "must be a list of UUIDs", { field: "evidenceIds" });
  }
  const owned = await one(ctx.deps.query, "SELECT id FROM documents WHERE id = $1 AND user_id = $2", [documentId, ctx.user.id]);
  if (!owned) throw notFound();
  return acceptJob(ctx, "document", { documentId, kind: "generate", body });
};
