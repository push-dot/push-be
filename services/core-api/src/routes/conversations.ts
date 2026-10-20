import { bytesToBase64, encryptAes, masterKey } from "../crypto.ts";
import { one, query } from "../db.ts";
import { HttpError, codePoints, data, requireUuid, uuid5Url } from "../http.ts";
import { revisionUpdate, ts } from "../page.ts";
import type { Ctx } from "../types.ts";

const AI_PROVIDERS = new Set(["OPENAI", "OPENROUTER", "CLAUDE", "GEMINI", "GROK"]);
const CREDENTIALS = new Set(["MANAGED", "BYOK"]);
const EFFORTS = new Set(["LOW", "MEDIUM", "HIGH", "MAX"]);
const CREDITS: Record<string, number> = { PRO: 30_000_000, ULTRA: 100_000_000 };

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

export async function createConversation(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  forbidExtra(body, ["applicationId", "title"]);
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
    "SELECT id, revision, application_id, title, pinned, archived, created_at FROM conversations WHERE id = $1 AND user_id = $2",
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
    "UPDATE conversations SET revision = revision + 1, application_id = $3, title = $4, pinned = $5, archived = $6, updated_at = $7 WHERE id = $1 AND user_id = $2 AND revision = $8 RETURNING id, revision, application_id, title, pinned, created_at, updated_at",
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
    "SELECT id, revision, application_id, title, pinned, created_at FROM conversations WHERE id = $1 AND user_id = $2",
    [id, ctx.user.id]);
  if (!current) throw new HttpError(404, "NOT_FOUND", "resource not found");
  if (Number(current.revision) !== body.expectedRevision) {
    throw new HttpError(409, "REVISION_CONFLICT", "resource was modified", { currentRevision: Number(current.revision) });
  }
  const now = ctx.now.toISOString();
  const updated = await revisionUpdate(ctx.deps.query, "conversations",
    "UPDATE conversations SET revision = revision + 1, application_id = $3, title = $4, pinned = $5, archived = true, updated_at = $6 WHERE id = $1 AND user_id = $2 AND revision = $7 RETURNING id, revision, application_id, title, pinned, created_at, updated_at",
    [id, ctx.user.id, current.application_id, current.title, current.pinned === true || current.pinned === "t", now, body.expectedRevision],
    id, ctx.user.id);
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
      const plan = String(user.plan);
      if (Number(spent?.spent || 0) >= (CREDITS[plan] || 0)) {
        throw new HttpError(403, "FEATURE_DISABLED", "monthly managed AI usage limit reached for plan " + plan);
      }
      if (String(ai.model).startsWith("opencode-go/")) {
        if (!flag(ctx.env.MANAGED_GO)) throw new HttpError(503, "NOT_CONFIGURED", "OpenCode Go is not configured");
      } else if (!flag(ctx.env.MANAGED_AI)) {
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

export async function postMessage(ctx: Ctx, idRaw: string): Promise<Response> {
  const conversationId = requireUuid(idRaw, "id");
  const body = await readObject(ctx.request);
  forbidExtra(body, ["text", "context", "ai", "accessMode"]);
  if (typeof body.text !== "string" || codePoints(body.text) < 1 || codePoints(body.text) > 20000) {
    throw new HttpError(400, "VALIDATION_ERROR", "text must be 1-20000 characters", { field: "text" });
  }
  const access = typeof body.accessMode === "string" ? body.accessMode : "";
  if (access !== "SUGGEST" && access !== "CONFIRM_ACTIONS") {
    throw new HttpError(400, "VALIDATION_ERROR", "must be SUGGEST or CONFIRM_ACTIONS", { field: "accessMode" });
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
  const byok = ctx.request.headers.get("x-byok-key") || "";
  await allowChat(ctx, ai, byok);
  const payload: Record<string, unknown> = { text: body.text, context, ai, accessMode: access };
  if (byok && ctx.env.BYOK_MASTER_KEY) {
    const key = await masterKey(ctx.env.BYOK_MASTER_KEY);
    const sealed = await encryptAes(key, byok, ctx.user.id, "chat-job");
    payload._byok = { ct: bytesToBase64(sealed.ciphertext), nonce: bytesToBase64(sealed.nonce) };
  }
  const jobId = crypto.randomUUID();
  const messageId = await uuid5Url("push:chat:" + jobId + ":user");
  const inserted = await one(ctx.deps.query,
    "WITH conv AS (SELECT id FROM conversations WHERE id = $2 AND user_id = $1), job AS (INSERT INTO chat_jobs (id, user_id, conversation_id, payload) SELECT $3, $1, conv.id, $4::jsonb FROM conv RETURNING id), msg AS (INSERT INTO messages (id, user_id, conversation_id, role, text, attachments, operation_id, created_at) SELECT $6, $1, conv.id, 'USER', $7, '[]'::jsonb, NULL, now() FROM conv ON CONFLICT (id) DO NOTHING RETURNING id), ev AS (INSERT INTO chat_events (job_id, type, payload) SELECT job.id, 'status', $5::jsonb FROM job RETURNING job_id) SELECT job.id FROM job JOIN ev ON ev.job_id = job.id LEFT JOIN msg ON true",
    [ctx.user.id, conversationId, jobId, JSON.stringify(payload), JSON.stringify({ text: "대기 중" }), messageId, body.text]);
  if (!inserted) throw new HttpError(404, "NOT_FOUND", "resource not found");
  // The VPS loop claims the inserted row. Skip the Cloudflare Workflow while
  // AI_ORIGIN is set. Clearing it schedules through the service binding again.
  if (!(ctx.env.AI_ORIGIN || "").trim()) {
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
