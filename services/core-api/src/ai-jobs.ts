import { one } from "./db.ts";
import { HttpError } from "./http.ts";
import type { Ctx } from "./types.ts";

export type ResumeJob = { conversationId: string; userId: string; payload: Record<string, unknown> };

const ENQUEUE_RESUME = `WITH conv AS (
    SELECT id FROM conversations WHERE id = $2 AND (user_id = $1 OR (company_id IS NOT NULL
      AND company_id = (SELECT company_id FROM company_members WHERE user_id = $1)))
  ), last AS (
    SELECT payload FROM chat_jobs WHERE conversation_id = $2 ORDER BY created_at DESC LIMIT 1
  ), job AS (
    INSERT INTO chat_jobs (id, user_id, conversation_id, payload)
    SELECT $3, $1, conv.id, COALESCE((SELECT jsonb_strip_nulls(jsonb_build_object(
        'ai', payload->'ai', 'access_mode', payload->'access_mode', 'accessMode', payload->'accessMode',
        'intent', payload->'intent', '_byok', payload->'_byok')) FROM last), '{}'::jsonb) || $4::jsonb
    FROM conv RETURNING id
  ), ev AS (
    INSERT INTO chat_events (job_id, type, payload) SELECT job.id, 'status', $5::jsonb FROM job RETURNING job_id
  ) SELECT job_id AS id FROM ev`;

const wake = async (ctx: Ctx, jobId: string): Promise<void> => {
  const body = JSON.stringify({ jobId, byok: "" });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-push-internal": "1",
    "x-request-id": ctx.rid,
  };
  const origin = (ctx.env.AI_ORIGIN || "").trim().replace(/\/+$/, "");
  if (!origin) {
    if (!ctx.env.API) throw new HttpError(500, "INTERNAL", "internal error");
    const scheduled = await ctx.env.API.fetch(new Request("https://push-be-python/internal/chat/schedule", { method: "POST", headers, body }));
    if (!scheduled.ok) throw new HttpError(500, "INTERNAL", "internal error");
    return;
  }
  const secret = (ctx.env.AI_SHARED_SECRET || "").trim();
  if (secret) headers["x-push-ai-secret"] = secret;
  try {
    const scheduled = await (ctx.deps.fetch ?? fetch)(origin + "/internal/chat/schedule", { method: "POST", headers, body });
    if (!scheduled.ok) console.error("vps resume wake failed", scheduled.status);
  } catch {
    console.error("vps resume wake failed");
  }
};

// shortcut: uses chat_jobs until feat/be-queue-rag merges, then switch to enqueueJob
export const enqueueResumeJob = async (ctx: Ctx, job: ResumeJob): Promise<string> => {
  const jobId = crypto.randomUUID();
  const inserted = await one(ctx.deps.query, ENQUEUE_RESUME, [
    job.userId, job.conversationId, jobId, JSON.stringify({ text: "", ...job.payload }), JSON.stringify({ text: "대기 중" }),
  ]);
  if (!inserted) throw new HttpError(404, "NOT_FOUND", "resource not found");
  await wake(ctx, jobId);
  return jobId;
};
