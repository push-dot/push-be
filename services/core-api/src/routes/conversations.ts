import { bytesToBase64, encryptAes, masterKey } from "../crypto.ts";
import { enqueueResumeJob } from "../ai-jobs.ts";
import { one, query } from "../db.ts";
import { HttpError, codePoints, data, requireUuid, uuid5Url } from "../http.ts";
import { revisionUpdate, ts } from "../page.ts";
import type { Ctx } from "../types.ts";

const AI_PROVIDERS = new Set(["OPENAI", "OPENROUTER", "CLAUDE", "GEMINI", "GROK"]);
const CREDENTIALS = new Set(["MANAGED", "BYOK"]);
const EFFORTS = new Set(["LOW", "MEDIUM", "HIGH", "MAX"]);
const CREDITS: Record<string, number> = { FREE: 1_800_000, PRO: 30_000_000, ULTRA: 100_000_000 };
const INTENTS = new Set(["posting", "review", "interview", "general"]);
const CANONICAL_ACCESS: Record<string, string> = {
  ALWAYS_ASK: "ALWAYS_ASK",
  AUTO: "AUTO",
  BYPASS: "BYPASS",
  SUGGEST: "AUTO",
  CONFIRM_ACTIONS: "ALWAYS_ASK",
};
const PDF_MAX_BYTES = 10 * 1024 * 1024;
const REJECT_WAITING = "rejected AS (UPDATE approvals SET status = 'REJECTED', updated_at = now(), revision = revision + 1 WHERE conversation_id = (SELECT id FROM conv) AND status = 'PENDING' AND kind <> 'RESUME_GATE' AND (kind = 'TOOL_ACTION' OR job_id IS NOT NULL) RETURNING id)";
const RESUMABLE = new Set(["TOOL_ACTION", "RESUME_GATE"]);

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
  if (postingId) {
    const posting = await one(ctx.deps.query, "SELECT id FROM job_postings WHERE id = $1", [postingId]);
    if (!posting) throw new HttpError(404, "NOT_FOUND", "resource not found");
  }
  if (applicationId) {
    const application = await one(ctx.deps.query, "SELECT id FROM applications WHERE id = $1", [applicationId]);
    if (!application) throw new HttpError(404, "NOT_FOUND", "resource not found");
  }
  const id = crypto.randomUUID();
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    "INSERT INTO conversations (id, user_id, revision, application_id, title, pinned, archived, created_at, updated_at, company_id, posting_id) VALUES ($1,$2,1,$3,$4,false,false,$5,$5,$6,$7)",
    [id, ctx.user.id, applicationId, body.title, now, String(member.company_id), postingId]);
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

export async function archiveConversation(ctx: Ctx, idRaw: string): Promise<Response> {
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
    "UPDATE conversations SET revision = revision + 1, application_id = $3, title = $4, pinned = $5, archived = true, updated_at = $6 WHERE " + visibleConversation("$1", "$2") + " AND revision = $7 RETURNING id, revision, application_id, title, pinned, created_at, updated_at",
    [id, ctx.user.id, current.application_id, current.title, current.pinned === true || current.pinned === "t", now, body.expectedRevision],
    id, ctx.user.id);
  if (current.company_id != null) {
    await query(ctx.deps.query, "DELETE FROM conversation_attachments WHERE conversation_id = $1", [id]);
  }
  const refs = await query(ctx.deps.query,
    "SELECT DISTINCT (a->>'id')::uuid AS eid FROM messages, jsonb_array_elements(attachments) a WHERE user_id = $1 AND conversation_id = $2 AND a->>'type' = 'EVIDENCE'",
    [ctx.user.id, id]);
  for (const ref of refs.rows) {
    const eid = String(ref.eid);
    const elsewhere = await one(ctx.deps.query,
      "SELECT count(*) AS n FROM messages, jsonb_array_elements(attachments) a WHERE user_id = $1 AND conversation_id <> $2 AND a->>'type' = 'EVIDENCE' AND a->>'id' = $3",
      [ctx.user.id, id, eid]);
    if (Number(elsewhere?.n || 0) > 0) continue;
    const evidence = await one(ctx.deps.query,
      "SELECT id, revision, archived FROM career_evidence WHERE id = $1 AND user_id = $2",
      [eid, ctx.user.id]);
    if (!evidence || evidence.archived === true || evidence.archived === "t") continue;
    try {
      await query(ctx.deps.query,
        "UPDATE career_evidence SET archived = true, revision = revision + 1, updated_at = $3 WHERE id = $1 AND user_id = $2 AND revision = $4 AND archived = false",
        [eid, ctx.user.id, now, evidence.revision]);
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
  forbidExtra(ai, ["provider", "model", "credentialMode", "effort", "ultraResume", "webSearch", "models"]);
  if (typeof ai.provider !== "string" || typeof ai.model !== "string" || typeof ai.credentialMode !== "string" || typeof ai.effort !== "string") {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
  if (!AI_PROVIDERS.has(ai.provider)) throw new HttpError(400, "VALIDATION_ERROR", "unsupported provider", { field: "ai.provider" });
  if (!ai.model) throw new HttpError(400, "VALIDATION_ERROR", "model is required", { field: "ai.model" });
  if (!CREDENTIALS.has(ai.credentialMode)) throw new HttpError(400, "VALIDATION_ERROR", "unsupported credentialMode", { field: "ai.credentialMode" });
  if (ai.credentialMode === "MANAGED" && ai.provider !== "OPENAI") {
    throw new HttpError(400, "VALIDATION_ERROR", "MANAGED is only supported for OPENAI", { field: "ai.credentialMode" });
  }
  if (!EFFORTS.has(ai.effort)) throw new HttpError(400, "VALIDATION_ERROR", "unsupported effort", { field: "ai.effort" });
  return {
    provider: ai.provider,
    model: ai.model,
    credentialMode: ai.credentialMode,
    effort: ai.effort,
    ultraResume: ai.ultraResume === true,
    webSearch: ai.webSearch === true,
    models: ai.models && typeof ai.models === "object" && !Array.isArray(ai.models) ? ai.models : {},
  };
}

async function allowChat(ctx: Ctx, ai: Record<string, unknown> | null, byok: string): Promise<void> {
  if (!ai) return;
  if (ai.ultraResume === true || ai.credentialMode === "MANAGED") {
    const user = await one(ctx.deps.query, "SELECT plan FROM users WHERE id = $1", [ctx.user.id]);
    if (!user) throw new HttpError(404, "NOT_FOUND", "resource not found");
    if (ai.ultraResume === true && String(user.plan) !== "ULTRA") {
      throw new HttpError(403, "FEATURE_DISABLED", "ultraResume requires the ULTRA plan");
    }
    if (ai.credentialMode === "MANAGED") {
      const start = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), 1)).toISOString();
      const spent = await one(ctx.deps.query,
        "SELECT COALESCE(SUM(cost_micro_credits), 0) AS spent FROM ai_usage WHERE user_id = $1 AND managed AND created_at >= $2 AND (status = 'SETTLED' OR (status = 'RESERVED' AND created_at > now() - interval '10 minutes'))",
        [ctx.user.id, start]);
      const raw = user.plan == null ? "" : String(user.plan).trim();
      const plan = raw === "" ? "FREE" : raw;
      if (Number(spent?.spent || 0) >= (CREDITS[plan] ?? 0)) {
        throw new HttpError(403, "FEATURE_DISABLED", "monthly managed AI usage limit reached for plan " + plan);
      }
      if (!flag(ctx.env.MANAGED_AI)) {
        throw new HttpError(503, "NOT_CONFIGURED", "managed AI is not configured");
      }
      return;
    }
  }
  if (byok) return;
  const has = await one(ctx.deps.query,
    "SELECT EXISTS(SELECT 1 FROM ai_keys WHERE user_id = $1 AND provider = $2) AS has",
    [ctx.user.id, String(ai.provider)]);
  if (!ctx.env.BYOK_MASTER_KEY || !has || has.has === false || has.has === "f") {
    throw new HttpError(409, "INTEGRATION_REQUIRED", "no BYOK key configured for " + String(ai.provider));
  }
}

async function wakeVps(ctx: Ctx, origin: string, jobId: string, byok: string): Promise<void> {
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
      body: JSON.stringify({ jobId, byok }),
    });
    if (!scheduled.ok) console.error("vps chat wake failed", scheduled.status);
  } catch {
    console.error("vps chat wake failed");
  }
}

export async function postMessage(ctx: Ctx, idRaw: string): Promise<Response> {
  const conversationId = requireUuid(idRaw, "id");
  const body = await readObject(ctx.request);
  forbidExtra(body, ["text", "context", "ai", "accessMode", "intent", "applicationId"]);
  if (typeof body.text !== "string" || codePoints(body.text) < 1 || codePoints(body.text) > 20000) {
    throw new HttpError(400, "VALIDATION_ERROR", "text must be 1-20000 characters", { field: "text" });
  }
  const access = typeof body.accessMode === "string" ? body.accessMode : "";
  let canonical = CANONICAL_ACCESS[access] ?? "";
  if (!access) {
    const saved = await one(ctx.deps.query,
      "SELECT to_jsonb(s)->>'ai_access_mode' AS ai_access_mode FROM user_settings s WHERE s.user_id = $1",
      [ctx.user.id]);
    canonical = CANONICAL_ACCESS[String(saved?.ai_access_mode ?? "")] ?? "AUTO";
  }
  if (!canonical) {
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
  const byok = ctx.request.headers.get("x-byok-key") || "";
  await allowChat(ctx, ai, byok);
  if (intent === "interview") {
    const owned = await one(ctx.deps.query,
      "SELECT c.company_id, co.plan FROM conversations c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id = $1 AND (c.user_id = $2 OR (" + memberOfCaller("c.company_id", "$2") + "))",
      [conversationId, ctx.user.id]);
    if (owned && owned.company_id != null) {
      const tier = owned.plan == null ? "" : String(owned.plan).trim().toUpperCase();
      if (tier !== "PRO" && tier !== "ULTRA") {
        throw new HttpError(403, "PLAN_REQUIRED", "interview requires the PRO plan", { requiredPlan: "PRO" });
      }
    }
  }
  const payload: Record<string, unknown> = {
    text: body.text, context, ai, accessMode: canonical, access_mode: canonical, intent, applicationId: messageApplicationId,
  };
  if (byok && ctx.env.BYOK_MASTER_KEY) {
    const key = await masterKey(ctx.env.BYOK_MASTER_KEY);
    const sealed = await encryptAes(key, byok, ctx.user.id, "chat-job");
    payload._byok = { ct: bytesToBase64(sealed.ciphertext), nonce: bytesToBase64(sealed.nonce) };
  }
  const jobId = crypto.randomUUID();
  const messageId = await uuid5Url("push:chat:" + jobId + ":user");
  const inserted = await one(ctx.deps.query,
    "WITH conv AS (SELECT id FROM conversations WHERE id = $2 AND (user_id = $1 OR (" + memberOfCaller("company_id", "$1") + "))), " + REJECT_WAITING + ", job AS (INSERT INTO chat_jobs (id, user_id, conversation_id, payload) SELECT $3, $1, conv.id, $4::jsonb FROM conv RETURNING id), msg AS (INSERT INTO messages (id, user_id, conversation_id, role, text, attachments, operation_id, created_at) SELECT $6, $1, conv.id, 'USER', $7, '[]'::jsonb, NULL, now() FROM conv ON CONFLICT (id) DO NOTHING RETURNING id), ev AS (INSERT INTO chat_events (job_id, type, payload) SELECT job.id, 'status', $5::jsonb FROM job RETURNING job_id) SELECT job.id FROM job JOIN ev ON ev.job_id = job.id LEFT JOIN msg ON true",
    [ctx.user.id, conversationId, jobId, JSON.stringify(payload), JSON.stringify({ text: "대기 중" }), messageId, body.text]);
  if (!inserted) throw new HttpError(404, "NOT_FOUND", "resource not found");
  // The VPS loop claims the inserted row. Skip the Cloudflare Workflow while
  // AI_ORIGIN is set. Clearing it schedules through the service binding again.
  const origin = (ctx.env.AI_ORIGIN || "").trim().replace(/\/+$/, "");
  if (!origin) {
    if (!ctx.env.API) throw new HttpError(500, "INTERNAL", "internal error");
    const scheduled = await ctx.env.API.fetch(new Request("https://push-be-python/internal/chat/schedule", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-push-internal": "1",
        "x-request-id": ctx.rid,
      },
      body: JSON.stringify({ jobId, byok }),
    }));
    if (!scheduled.ok) throw new HttpError(500, "INTERNAL", "internal error");
  } else {
    await wakeVps(ctx, origin, jobId, byok);
  }
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
  if (String(row.plan || "") !== "ULTRA") {
    throw new HttpError(403, "PLAN_REQUIRED", "pdf attachments require the ULTRA plan", { requiredPlan: "ULTRA" });
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
    const jobId = await enqueueResumeJob(ctx, { conversationId, userId: ctx.user.id, payload: { resume: { approvalId, optionId } } });
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
  const jobId = await enqueueResumeJob(ctx, { conversationId, userId: ctx.user.id, payload: { resume: body.resume } });
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
