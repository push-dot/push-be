import { base64ToBytes } from "../crypto.ts";
import { enqueueResumeJob } from "../ai-jobs.ts";
import { one, query } from "../db.ts";
import { HttpError, asBool, codePoints, data, noContent, requireUuid, uuid5Url } from "../http.ts";
import { checkBackpressure } from "../jobs/backpressure.ts";
import { assertPlanAllows, planTier, queueFor } from "../jobs/config.ts";
import { enqueueJob, kickDispatcher, withDispatcher } from "../jobs/enqueue.ts";
import { revisionUpdate, ts } from "../page.ts";
import type { Ctx } from "../types.ts";

const AI_PROVIDERS = new Set(["OPENAI", "OPENROUTER", "CLAUDE", "GEMINI", "GROK"]);
const EFFORTS = new Set(["LOW", "MEDIUM", "HIGH", "MAX"]);
const PLAN_EFFORT: Record<string, string> = {
  "PERSONAL:FREE": "LOW",
  "PERSONAL:PRO": "MEDIUM",
  "PERSONAL:ULTRA": "HIGH",
  "EMPLOYER:BASIC": "MEDIUM",
  "EMPLOYER:PRO": "HIGH",
  "EMPLOYER:ULTRA": "MAX",
};

const effortFor = (audience: "PERSONAL" | "EMPLOYER", plan: unknown): string => {
  const tier = plan == null ? "" : String(plan).trim().toUpperCase();
  if (audience === "EMPLOYER") return PLAN_EFFORT[`EMPLOYER:${tier}`] ?? "MEDIUM";
  return PLAN_EFFORT[`PERSONAL:${tier || "FREE"}`] ?? "LOW";
};
const CREDITS: Record<string, number> = { FREE: 1_800_000, PRO: 27_000_000, ULTRA: 108_000_000 };
const INTENTS = new Set(["posting", "review", "interview", "general"]);
const CANONICAL_ACCESS: Record<string, string> = {
  ALWAYS_ASK: "ALWAYS_ASK",
  AUTO: "AUTO",
  BYPASS: "BYPASS",
  SUGGEST: "AUTO",
  CONFIRM_ACTIONS: "ALWAYS_ASK",
};
const PDF_MAX_BYTES = 10 * 1024 * 1024;
const FORM_OVERHEAD_BYTES = 64 * 1024;
const REJECT_WAITING = "rejected AS (UPDATE approvals SET status = 'REJECTED', updated_at = now(), revision = revision + 1 WHERE conversation_id = (SELECT id FROM conv) AND status = 'PENDING' AND kind <> 'RESUME_GATE' AND (kind = 'TOOL_ACTION' OR job_id IS NOT NULL) RETURNING id)";
const RESUMABLE = new Set(["TOOL_ACTION", "RESUME_GATE"]);
const EVIDENCE_REFS = "SELECT (a->>'id')::uuid FROM messages m, jsonb_array_elements(m.attachments) a WHERE m.user_id = $1 AND a->>'type' = 'EVIDENCE' AND a->>'id' IS NOT NULL";
const AGENT_CONSENT = "SELECT reference_data FROM user_consents WHERE user_id = $1";
const ARCHIVE_ORPHAN_EVIDENCE = "UPDATE career_evidence e SET archived = true, revision = e.revision + 1, updated_at = $3"
  + " WHERE e.user_id = $1 AND e.archived = false"
  + ` AND e.id IN (${EVIDENCE_REFS} AND m.conversation_id = $2)`
  + ` AND e.id NOT IN (${EVIDENCE_REFS} AND m.conversation_id <> $2)`;

async function requireAgentConsent(ctx: Ctx): Promise<void> {
  const row = await one(ctx.deps.query, AGENT_CONSENT, [ctx.user.id]);
  if (!asBool(row?.reference_data)) {
    throw new HttpError(403, "CONSENT_REQUIRED", "reference data consent is required");
  }
}

function flag(value: string | undefined): boolean {
  const v = (value || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw) throw new HttpError(400, "VALIDATION_ERROR", "request body required");
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, "VALIDATION_ERROR", "invalid request body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
  return body as Record<string, unknown>;
}

function forbidExtra(body: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
}

function convDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    applicationId: row.application_id == null ? null : String(row.application_id),
    title: String(row.title ?? ""),
    pinned: row.pinned === true || row.pinned === "t",
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
  };
}

const optionalUuid = (value: unknown, field: string): string | null => {
  if (value == null) return null;
  return requireUuid(String(value), field);
};

const memberOfCaller = (companyExpr: string, userParam: string): string =>
  `${companyExpr} IS NOT NULL AND ${companyExpr} = (SELECT company_id FROM company_members WHERE user_id = ${userParam})`;

const visibleConversation = (idParam: string, userParam: string): string =>
  `id = ${idParam} AND (user_id = ${userParam} OR (${memberOfCaller("company_id", userParam)}))`;

const COMPANY_APPLICATION = "SELECT a.id FROM applications a JOIN jobs j ON j.id = a.job_id JOIN job_postings p ON p.id = j.source_posting_id WHERE a.id = $1 AND p.company_id = $2";

const createEmployerConversation = async (ctx: Ctx, body: Record<string, unknown>): Promise<Response> => {
  forbidExtra(body, ["audience", "title", "postingId", "applicationId"]);
  if (typeof body.title !== "string") throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  if (codePoints(body.title) > 300) {
    throw new HttpError(400, "VALIDATION_ERROR", "title must be at most 300 characters", { field: "title" });
  }
  const postingId = optionalUuid(body.postingId, "postingId");
  const applicationId = optionalUuid(body.applicationId, "applicationId");
  const member = await one(ctx.deps.query,
    "SELECT m.company_id, m.role, c.verified_at, c.plan FROM company_members m JOIN companies c ON c.id = m.company_id WHERE m.user_id = $1",
    [ctx.user.id]);
  if (!member || member.verified_at == null) {
    throw new HttpError(403, "BUSINESS_NOT_VERIFIED", "company is not verified");
  }
  const companyId = String(member.company_id);
  const [posting, application] = await Promise.all([
    postingId ? one(ctx.deps.query, "SELECT id FROM job_postings WHERE id = $1", [postingId]) : null,
    applicationId ? one(ctx.deps.query, COMPANY_APPLICATION, [applicationId, companyId]) : null,
  ]);
  if ((postingId && !posting) || (applicationId && !application)) throw new HttpError(404, "NOT_FOUND", "resource not found");
  const id = crypto.randomUUID();
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    "INSERT INTO conversations (id, user_id, revision, application_id, title, pinned, archived, created_at, updated_at, company_id, posting_id) VALUES ($1,$2,1,$3,$4,false,false,$5,$5,$6,$7)",
    [id, ctx.user.id, applicationId, body.title, now, companyId, postingId]);
  return data(201, convDto({
    id, revision: 1, application_id: applicationId, title: body.title, pinned: false, created_at: now, updated_at: now,
  }), ctx.rid);
};

export async function createConversation(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  if (body.audience === "EMPLOYER") return createEmployerConversation(ctx, body);
  forbidExtra(body, body.audience == null ? ["applicationId", "title"] : ["applicationId", "title", "audience"]);
  if (body.audience != null && body.audience !== "PERSONAL") {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
  if (typeof body.title !== "string") throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  if (codePoints(body.title) > 300) {
    throw new HttpError(400, "VALIDATION_ERROR", "title must be at most 300 characters", { field: "title" });
  }
  await requireAgentConsent(ctx);
  let applicationId: string | null = null;
  if (body.applicationId != null) {
    applicationId = requireUuid(String(body.applicationId), "applicationId");
    const app = await one(ctx.deps.query, "SELECT id FROM applications WHERE id = $1 AND user_id = $2", [applicationId, ctx.user.id]);
    if (!app) throw new HttpError(404, "NOT_FOUND", "resource not found");
  }
  const id = crypto.randomUUID();
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    "INSERT INTO conversations (id, user_id, revision, application_id, title, pinned, archived, created_at, updated_at) VALUES ($1,$2,1,$3,$4,false,false,$5,$5)",
    [id, ctx.user.id, applicationId, body.title, now]);
  return data(201, convDto({
    id, revision: 1, application_id: applicationId, title: body.title, pinned: false, created_at: now, updated_at: now,
  }), ctx.rid);
}

export async function patchConversation(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const body = await readObject(ctx.request);
  forbidExtra(body, ["expectedRevision", "title", "pinned"]);
  if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision)) {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
  const current = await one(ctx.deps.query,
    "SELECT id, revision, application_id, title, pinned, archived, created_at FROM conversations WHERE " + visibleConversation("$1", "$2"),
    [id, ctx.user.id]);
  if (!current) throw new HttpError(404, "NOT_FOUND", "resource not found");
  if (Number(current.revision) !== body.expectedRevision) {
    throw new HttpError(409, "REVISION_CONFLICT", "resource was modified", { currentRevision: Number(current.revision) });
  }
  let title = String(current.title ?? "");
  if (body.title != null) {
    if (typeof body.title !== "string") throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
    if (codePoints(body.title) > 300) {
      throw new HttpError(400, "VALIDATION_ERROR", "title must be at most 300 characters", { field: "title" });
    }
    title = body.title;
  }
  let pinned = current.pinned === true || current.pinned === "t";
  if (body.pinned != null) {
    if (typeof body.pinned !== "boolean") throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
    pinned = body.pinned;
  }
  const now = ctx.now.toISOString();
  const updated = await revisionUpdate(ctx.deps.query, "conversations",
    "UPDATE conversations SET revision = revision + 1, application_id = $3, title = $4, pinned = $5, archived = $6, updated_at = $7 WHERE " + visibleConversation("$1", "$2") + " AND revision = $8 RETURNING id, revision, application_id, title, pinned, created_at, updated_at",
    [id, ctx.user.id, current.application_id, title, pinned, current.archived === true || current.archived === "t", now, body.expectedRevision],
    id, ctx.user.id);
  return data(200, convDto(updated), ctx.rid);
}

const DELETE_OWNED = "WITH owned AS (SELECT id FROM conversations WHERE id = $1 AND user_id = $2), "
  + "dropped_jobs AS (DELETE FROM chat_jobs WHERE conversation_id IN (SELECT id FROM owned)), "
  + "dropped_messages AS (DELETE FROM messages WHERE conversation_id IN (SELECT id FROM owned)), "
  + "dropped_files AS (DELETE FROM workspace_files WHERE conversation_id IN (SELECT id FROM owned)) "
  + "DELETE FROM conversations WHERE id IN (SELECT id FROM owned) RETURNING id";

const DELETE_COMPANY = "WITH owned AS (SELECT id FROM conversations WHERE id = $1 AND company_id IS NOT NULL), "
  + "dropped_jobs AS (DELETE FROM chat_jobs WHERE conversation_id IN (SELECT id FROM owned)), "
  + "dropped_messages AS (DELETE FROM messages WHERE conversation_id IN (SELECT id FROM owned)), "
  + "dropped_files AS (DELETE FROM workspace_files WHERE conversation_id IN (SELECT id FROM owned)) "
  + "DELETE FROM conversations WHERE id IN (SELECT id FROM owned) RETURNING id";

export async function deleteConversation(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const row = await one(ctx.deps.query, "SELECT user_id, company_id FROM conversations WHERE id = $1", [id]);
  if (!row) throw new HttpError(404, "NOT_FOUND", "resource not found");
  if (row.company_id != null) {
    const member = await one(ctx.deps.query,
      "SELECT role FROM company_members WHERE user_id = $1 AND company_id = $2",
      [ctx.user.id, row.company_id]);
    if (!member || String(member.role) !== "ADMIN") throw new HttpError(403, "FORBIDDEN", "admin required");
    const gone = await one(ctx.deps.query, DELETE_COMPANY, [id]);
    if (!gone) throw new HttpError(404, "NOT_FOUND", "resource not found");
    return noContent(ctx.rid);
  }
  const gone = await one(ctx.deps.query, DELETE_OWNED, [id, ctx.user.id]);
  if (!gone) throw new HttpError(404, "NOT_FOUND", "resource not found");
  return noContent(ctx.rid);
}

export async function archiveConversation(ctx: Ctx, idRaw: string, archived = true): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const body = await readObject(ctx.request);
  forbidExtra(body, ["expectedRevision"]);
  if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision)) {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
  const current = await one(ctx.deps.query,
    "SELECT id, revision, application_id, title, pinned, created_at, company_id FROM conversations WHERE " + visibleConversation("$1", "$2"),
    [id, ctx.user.id]);
  if (!current) throw new HttpError(404, "NOT_FOUND", "resource not found");
  if (Number(current.revision) !== body.expectedRevision) {
    throw new HttpError(409, "REVISION_CONFLICT", "resource was modified", { currentRevision: Number(current.revision) });
  }
  const now = ctx.now.toISOString();
  const updated = await revisionUpdate(ctx.deps.query, "conversations",
    "UPDATE conversations SET revision = revision + 1, application_id = $3, title = $4, pinned = $5, archived = " + (archived ? "true" : "false") + ", updated_at = $6 WHERE " + visibleConversation("$1", "$2") + " AND revision = $7 RETURNING id, revision, application_id, title, pinned, created_at, updated_at",
    [id, ctx.user.id, current.application_id, current.title, current.pinned === true || current.pinned === "t", now, body.expectedRevision],
    id, ctx.user.id);
  if (archived && current.company_id != null) {
    await query(ctx.deps.query, "DELETE FROM conversation_attachments WHERE conversation_id = $1", [id]);
  }
  if (archived) {
    try {
      await query(ctx.deps.query, ARCHIVE_ORPHAN_EVIDENCE, [ctx.user.id, id, now]);
    } catch {
      // A conflicting evidence write does not fail the archive.
    }
  }
  return data(200, convDto(updated), ctx.rid);
}

function aiDto(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
  const ai = raw as Record<string, unknown>;
  forbidExtra(ai, ["provider", "model", "effort", "ultraResume", "webSearch", "models"]);
  if (typeof ai.provider !== "string" || typeof ai.model !== "string") {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
  if (!AI_PROVIDERS.has(ai.provider)) throw new HttpError(400, "VALIDATION_ERROR", "unsupported provider", { field: "ai.provider" });
  if (!ai.model) throw new HttpError(400, "VALIDATION_ERROR", "model is required", { field: "ai.model" });
  if (ai.effort != null && (typeof ai.effort !== "string" || !EFFORTS.has(ai.effort))) {
    throw new HttpError(400, "VALIDATION_ERROR", "unsupported effort", { field: "ai.effort" });
  }
  return {
    provider: ai.provider,
    model: ai.model,
    effort: "LOW",
    ultraResume: ai.ultraResume === true,
    webSearch: ai.webSearch === true,
    models: ai.models && typeof ai.models === "object" && !Array.isArray(ai.models) ? ai.models : {},
  };
}

async function allowChat(ctx: Ctx, ai: Record<string, unknown> | null): Promise<void> {
  if (!ai) return;
  const start = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), 1)).toISOString();
  const [user, spent] = await Promise.all([
    one(ctx.deps.query, "SELECT plan FROM users WHERE id = $1", [ctx.user.id]),
    one(ctx.deps.query,
      "SELECT COALESCE(SUM(cost_micro_credits), 0) AS spent FROM ai_usage WHERE user_id = $1 AND managed AND created_at >= $2 AND status IN ('SETTLED', 'RESERVED')",
      [ctx.user.id, start]),
  ]);
  if (!user) throw new HttpError(404, "NOT_FOUND", "resource not found");
  if (ai.ultraResume === true && String(user.plan) !== "ULTRA") {
    throw new HttpError(403, "FEATURE_DISABLED", "ultraResume requires the ULTRA plan");
  }
  const raw = user.plan == null ? "" : String(user.plan).trim();
  const plan = raw === "" ? "FREE" : raw;
  if (Number(spent?.spent || 0) >= (CREDITS[plan] ?? 0)) {
    throw new HttpError(403, "FEATURE_DISABLED", "monthly managed AI usage limit reached for plan " + plan);
  }
  if (!flag(ctx.env.MANAGED_AI)) {
    throw new HttpError(503, "NOT_CONFIGURED", "managed AI is not configured");
  }
}

async function wakeVps(ctx: Ctx, origin: string, jobId: string): Promise<void> {
  const fetchImpl = ctx.deps.fetch ?? fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-push-internal": "1",
    "x-request-id": ctx.rid,
  };
  const secret = (ctx.env.AI_SHARED_SECRET || "").trim();
  if (secret) headers["x-push-ai-secret"] = secret;
  try {
    const scheduled = await fetchImpl(origin + "/internal/chat/schedule", {
      method: "POST",
      headers,
      body: JSON.stringify({ jobId }),
    });
    if (!scheduled.ok) console.error("vps chat wake failed", scheduled.status);
  } catch {
    console.error("vps chat wake failed");
  }
}

// The VPS loop claims the inserted row. Skip the Cloudflare Workflow while
// AI_ORIGIN is set. Clearing it schedules through the service binding again.
export const scheduleChatJob = async (ctx: Ctx, jobId: string): Promise<void> => {
  const origin = (ctx.env.AI_ORIGIN || "").trim().replace(/\/+$/, "");
  if (origin) {
    await wakeVps(ctx, origin, jobId);
    return;
  }
  if (!ctx.env.API) throw new HttpError(500, "INTERNAL", "internal error");
  const scheduled = await ctx.env.API.fetch(new Request("https://push-be-python/internal/chat/schedule", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-push-internal": "1",
      "x-request-id": ctx.rid,
    },
    body: JSON.stringify({ jobId }),
  }));
  if (!scheduled.ok) throw new HttpError(500, "INTERNAL", "internal error");
};

const enqueueChatMessage = async (
  ctx: Ctx,
  conversationId: string,
  payload: Record<string, unknown>,
  text: string,
): Promise<Response> => {
  const owned = await one(ctx.deps.query,
    "SELECT c.id, c.company_id, co.plan AS company_plan, u.plan AS user_plan FROM conversations c LEFT JOIN companies co ON co.id = c.company_id LEFT JOIN users u ON u.id = $2 WHERE c.id = $1 AND (c.user_id = $2 OR (" + memberOfCaller("c.company_id", "$2") + "))",
    [conversationId, ctx.user.id]);
  if (!owned) throw new HttpError(404, "NOT_FOUND", "resource not found");
  const companyId = owned.company_id == null ? undefined : String(owned.company_id);
  const plan = planTier(companyId ? owned.company_plan : owned.user_plan);
  const type = companyId ? "employer_ai" : "chat";
  const audience = companyId ? "EMPLOYER" : "PERSONAL";
  const queue = queueFor(type, plan, audience);
  const pressure = await checkBackpressure(ctx.deps.query, queue, plan);
  if (!pressure.ok) {
    throw new HttpError(429, "QUEUE_BUSY", "queue is busy", { retryAfterSec: pressure.retryAfterSec });
  }
  const headerKey = (ctx.request.headers.get("idempotency-key") || "").trim();
  const { jobId } = await enqueueJob(ctx.deps.query, {
    type,
    userId: ctx.user.id,
    companyId,
    plan,
    payload,
    idempotencyKey: headerKey || undefined,
    conversationId,
  });
  const messageId = await uuid5Url("push:chat:" + jobId + ":user");
  const inserted = await one(ctx.deps.query,
    "WITH conv AS (SELECT id FROM conversations WHERE id = $2 AND (user_id = $1 OR (" + memberOfCaller("company_id", "$1") + "))), " + REJECT_WAITING + ", msg AS (INSERT INTO messages (id, user_id, conversation_id, role, text, attachments, operation_id, created_at) SELECT $4, $1, conv.id, 'USER', $5, '[]'::jsonb, NULL, now() FROM conv ON CONFLICT (id) DO NOTHING RETURNING id), ev AS (INSERT INTO chat_events (job_id, type, payload) SELECT $3, 'status', $6::jsonb FROM conv RETURNING job_id) SELECT conv.id FROM conv",
    [ctx.user.id, conversationId, jobId, messageId, text, JSON.stringify({ text: "대기 중" })]);
  if (!inserted) throw new HttpError(404, "NOT_FOUND", "resource not found");
  await withDispatcher(ctx.env, ctx.deps.fetch ?? fetch, () => kickDispatcher(queue));
  const now = ts(ctx.now);
  return data(202, {
    id: jobId,
    type: "CHAT_MESSAGE",
    applicationId: null,
    status: "QUEUED",
    progress: null,
    result: { kind: "CHAT_MESSAGE", value: { jobId } },
    error: null,
    inputRequest: null,
    createdAt: now,
    updatedAt: now,
  }, ctx.rid);
};

export async function postMessage(ctx: Ctx, idRaw: string): Promise<Response> {
  const conversationId = requireUuid(idRaw, "id");
  const body = await readObject(ctx.request);
  forbidExtra(body, ["text", "context", "ai", "accessMode", "intent", "applicationId"]);
  if (typeof body.text !== "string" || codePoints(body.text) < 1 || codePoints(body.text) > 20000) {
    throw new HttpError(400, "VALIDATION_ERROR", "text must be 1-20000 characters", { field: "text" });
  }
  const access = typeof body.accessMode === "string" ? body.accessMode : "";
  if (access && !CANONICAL_ACCESS[access]) {
    throw new HttpError(400, "VALIDATION_ERROR", "must be ALWAYS_ASK, AUTO, BYPASS, SUGGEST, or CONFIRM_ACTIONS", { field: "accessMode" });
  }
  let context: Record<string, unknown> = {};
  if (body.context != null) {
    if (!body.context || typeof body.context !== "object" || Array.isArray(body.context)) {
      throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
    }
    const c = body.context as Record<string, unknown>;
    forbidExtra(c, ["documentId", "versionId", "evidenceIds"]);
    const evidence: string[] = [];
    if (c.evidenceIds != null) {
      if (!Array.isArray(c.evidenceIds)) throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
      for (const item of c.evidenceIds) evidence.push(requireUuid(String(item), "evidenceIds"));
    }
    context = {
      documentId: c.documentId == null ? null : requireUuid(String(c.documentId), "documentId"),
      versionId: c.versionId == null ? null : requireUuid(String(c.versionId), "versionId"),
      evidenceIds: evidence,
    };
  }
  const ai = aiDto(body.ai);
  let intent: string | null = null;
  if (body.intent != null) {
    if (typeof body.intent !== "string" || !INTENTS.has(body.intent)) {
      throw new HttpError(400, "VALIDATION_ERROR", "unsupported intent", { field: "intent" });
    }
    intent = body.intent;
  }
  const messageApplicationId = optionalUuid(body.applicationId, "applicationId");
  const [saved, owned] = await Promise.all([
    access ? null : one(ctx.deps.query,
      "SELECT to_jsonb(s)->>'ai_access_mode' AS ai_access_mode FROM user_settings s WHERE s.user_id = $1",
      [ctx.user.id]),
    one(ctx.deps.query,
      "SELECT c.company_id, co.plan, co.verified_at FROM conversations c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id = $1 AND (c.user_id = $2 OR (" + memberOfCaller("c.company_id", "$2") + "))",
      [conversationId, ctx.user.id]),
    allowChat(ctx, ai),
  ]);
  const canonical = access ? CANONICAL_ACCESS[access] : CANONICAL_ACCESS[String(saved?.ai_access_mode ?? "")] ?? "AUTO";
  if (ai && owned && owned.company_id != null) ai.effort = effortFor("EMPLOYER", owned.plan);
  else if (ai) ai.effort = effortFor("PERSONAL", ctx.user.plan);
  if (owned && owned.company_id == null) await requireAgentConsent(ctx);
  if (owned && owned.company_id != null) {
    if (owned.verified_at == null) throw new HttpError(403, "BUSINESS_NOT_VERIFIED", "company is not verified");
    if (intent === "interview") assertPlanAllows(owned.plan, "employer_interview");
  }
  const payload: Record<string, unknown> = {
    text: body.text, context, ai, accessMode: canonical, access_mode: canonical, intent, applicationId: messageApplicationId,
  };
  if ((ctx.env.QUEUE_BACKEND || "").trim().toLowerCase() === "redis") {
    return enqueueChatMessage(ctx, conversationId, payload, body.text);
  }
  const jobId = crypto.randomUUID();
  const messageId = await uuid5Url("push:chat:" + jobId + ":user");
  const inserted = await one(ctx.deps.query,
    "WITH conv AS (SELECT id FROM conversations WHERE id = $2 AND (user_id = $1 OR (" + memberOfCaller("company_id", "$1") + "))), " + REJECT_WAITING + ", job AS (INSERT INTO chat_jobs (id, user_id, conversation_id, payload) SELECT $3, $1, conv.id, $4::jsonb FROM conv RETURNING id), msg AS (INSERT INTO messages (id, user_id, conversation_id, role, text, attachments, operation_id, created_at) SELECT $6, $1, conv.id, 'USER', $7, '[]'::jsonb, NULL, now() FROM conv ON CONFLICT (id) DO NOTHING RETURNING id), ev AS (INSERT INTO chat_events (job_id, type, payload) SELECT job.id, 'status', $5::jsonb FROM job RETURNING job_id) SELECT job.id FROM job JOIN ev ON ev.job_id = job.id LEFT JOIN msg ON true",
    [ctx.user.id, conversationId, jobId, JSON.stringify(payload), JSON.stringify({ text: "대기 중" }), messageId, body.text]);
  if (!inserted) throw new HttpError(404, "NOT_FOUND", "resource not found");
  await scheduleChatJob(ctx, jobId);
  const now = ts(ctx.now);
  return data(202, {
    id: jobId,
    type: "CHAT_MESSAGE",
    applicationId: null,
    status: "QUEUED",
    progress: null,
    result: { kind: "CHAT_MESSAGE", value: { jobId } },
    error: null,
    inputRequest: null,
    createdAt: now,
    updatedAt: now,
  }, ctx.rid);
}

export const postAttachment = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const conversationId = requireUuid(idRaw, "id");
  const row = await one(ctx.deps.query,
    "SELECT c.id, c.company_id, co.plan, co.verified_at FROM conversations c JOIN company_members m ON m.company_id = c.company_id AND m.user_id = $2 JOIN companies co ON co.id = c.company_id WHERE c.id = $1",
    [conversationId, ctx.user.id]);
  if (!row) throw new HttpError(404, "NOT_FOUND", "resource not found");
  if (row.verified_at == null) {
    throw new HttpError(403, "BUSINESS_NOT_VERIFIED", "company is not verified");
  }
  assertPlanAllows(row.plan, "pdf_attachment");
  if (Number(ctx.request.headers.get("content-length") ?? 0) > PDF_MAX_BYTES + FORM_OVERHEAD_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "file must be at most 10 MiB", { field: "file" });
  }
  const form = await ctx.request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new HttpError(400, "VALIDATION_ERROR", "file is required", { field: "file" });
  }
  if (file.type !== "application/pdf") {
    throw new HttpError(400, "VALIDATION_ERROR", "only pdf files are accepted", { field: "file" });
  }
  if (file.size > PDF_MAX_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "file must be at most 10 MiB", { field: "file" });
  }
  const content = new Uint8Array(await file.arrayBuffer());
  const id = crypto.randomUUID();
  await query(ctx.deps.query,
    "INSERT INTO conversation_attachments (id, conversation_id, company_id, file_name, mime_type, content) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, conversationId, String(row.company_id), file.name, file.type, content]);
  return data(201, { id, fileName: file.name, mimeType: file.type }, ctx.rid);
};

const optionIds = (raw: unknown): string[] => {
  const list = typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
  if (!Array.isArray(list)) return [];
  return list.map((item) => (item && typeof item === "object" ? String((item as Record<string, unknown>).id ?? "") : ""));
};

export const resolveApproval = async (ctx: Ctx, idRaw: string, approvalRaw: string): Promise<Response> => {
  const conversationId = requireUuid(idRaw, "id");
  const approvalId = requireUuid(approvalRaw, "approvalId");
  const body = await readObject(ctx.request);
  forbidExtra(body, ["optionId"]);
  if (typeof body.optionId !== "string" || !body.optionId) {
    throw new HttpError(400, "VALIDATION_ERROR", "optionId is required", { field: "optionId" });
  }
  const optionId = body.optionId;
  const row = await one(ctx.deps.query,
    "SELECT id, status, kind, options, job_id, expires_at FROM approvals WHERE id = $1 AND conversation_id = $2 AND user_id = $3",
    [approvalId, conversationId, ctx.user.id]);
  if (!row) throw new HttpError(404, "NOT_FOUND", "resource not found");
  if (!optionIds(row.options).includes(optionId)) {
    throw new HttpError(400, "VALIDATION_ERROR", "unknown option", { field: "optionId" });
  }
  if (row.status !== "PENDING") throw new HttpError(409, "APPROVAL_ALREADY_RESOLVED", "approval already resolved");
  if (row.expires_at != null && Date.parse(String(row.expires_at)) <= ctx.now.getTime()) {
    await query(ctx.deps.query, "UPDATE approvals SET status = 'EXPIRED', updated_at = now() WHERE id = $1 AND status = 'PENDING'", [approvalId]);
    throw new HttpError(410, "APPROVAL_EXPIRED", "approval expired");
  }
  const kind = String(row.kind ?? "");
  const status = kind === "TOOL_ACTION" && optionId === "reject" ? "REJECTED" : "APPROVED";
  const updated = await one(ctx.deps.query,
    "UPDATE approvals SET status = $1, option_id = $2, decided_at = now(), updated_at = now(), revision = revision + 1 WHERE id = $3 AND status = 'PENDING' RETURNING id",
    [status, optionId, approvalId]);
  if (!updated) throw new HttpError(409, "APPROVAL_ALREADY_RESOLVED", "approval already resolved");
  const result = { id: approvalId, status, optionId };
  const resumes = RESUMABLE.has(kind) || row.job_id != null;
  const appliesEdit = kind === "DOCUMENT_EDIT" && optionId === "apply";
  if (!resumes && !appliesEdit) return data(200, result, ctx.rid);
  try {
    const jobId = await enqueueResumeJob(ctx, {
      conversationId, userId: ctx.user.id, payload: { resume: { approvalId, optionId } }, idempotencyKey: `approval:${approvalId}`,
    });
    return data(resumes ? 202 : 200, { ...result, jobId }, ctx.rid);
  } catch (err) {
    await query(ctx.deps.query,
      "UPDATE approvals SET status = 'PENDING', option_id = NULL, decided_at = NULL, updated_at = now() WHERE id = $1 AND status = $2",
      [approvalId, status]);
    throw err;
  }
};

export const postResumeJob = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const conversationId = requireUuid(idRaw, "id");
  if (!ctx.request.headers.has("x-push-act-as")) throw new HttpError(404, "NOT_FOUND", "resource not found");
  const body = await readObject(ctx.request);
  forbidExtra(body, ["resume"]);
  if (!body.resume || typeof body.resume !== "object" || Array.isArray(body.resume)) {
    throw new HttpError(400, "VALIDATION_ERROR", "resume is required", { field: "resume" });
  }
  const key = (ctx.request.headers.get("idempotency-key") || "").trim();
  const jobId = await enqueueResumeJob(ctx, {
    conversationId, userId: ctx.user.id, payload: { resume: body.resume }, idempotencyKey: key ? `resume:${key}` : undefined,
  });
  return data(202, { jobId }, ctx.rid);
};

const APPROVAL_PATH = /^\/api\/v1\/conversations\/[^/]+\/approvals\/([^/]+)$/;

export const withApprovalAnswerKey = async (ctx: Ctx, path: string): Promise<Ctx> => {
  const approval = path.match(APPROVAL_PATH);
  if (!approval || ctx.request.headers.has("idempotency-key")) return ctx;
  let optionId = "";
  try {
    const body = JSON.parse(await ctx.request.clone().text()) as Record<string, unknown>;
    optionId = typeof body.optionId === "string" ? body.optionId : "";
  } catch {
    return ctx;
  }
  const headers = new Headers(ctx.request.headers);
  headers.set("idempotency-key", await uuid5Url(`push:approval-answer:${approval[1]}:${optionId}`));
  return { ...ctx, request: new Request(ctx.request, { headers }) };
};

const ARTIFACT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

const artifactName = (raw: string): string => {
  let name: string;
  try { name = decodeURIComponent(raw); } catch { throw new HttpError(400, "VALIDATION_ERROR", "invalid artifact name"); }
  if (!name || name.startsWith(".") || /[/\\\0]/.test(name) || name.includes("..")) {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid artifact name");
  }
  return name;
};

const ARTIFACT_SQL = "SELECT encode(COALESCE(content, convert_to(body, 'UTF8')), 'base64') AS content FROM workspace_files"
  + " WHERE conversation_id = $1 AND name = $3 AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = $1 AND (c.user_id = $2 OR ("
  + memberOfCaller("c.company_id", "$2") + ")))";

/** GET /conversations/:id/artifacts/:name — bytes of one harness artifact from workspace_files. */
export const getArtifact = async (ctx: Ctx, idRaw: string, nameRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const name = artifactName(nameRaw);
  const row = await one(ctx.deps.query, ARTIFACT_SQL, [id, ctx.user.id, name]);
  if (!row || row.content == null) throw new HttpError(404, "NOT_FOUND", "resource not found");
  const bytes = base64ToBytes(String(row.content).replace(/\s+/g, ""));
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      "content-type": ARTIFACT_TYPES[ext] ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "x-content-type-options": "nosniff",
      "x-request-id": ctx.rid,
    },
  });
};
