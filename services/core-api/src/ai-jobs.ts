import { one } from "./db.ts";
import type { DbValue } from "./db.ts";
import { HttpError } from "./http.ts";
import { planTier } from "./jobs/config.ts";
import { enqueueJob, kickDispatcher, withDispatcher } from "./jobs/enqueue.ts";
import { scheduleChatJob } from "./conversations/schedule-chat-job.ts";
import type { Json, JsonObject } from "./json.ts";
import type { Ctx } from "./types.ts";

export type ResumeJob = {
  conversationId: string;
  userId: string;
  payload: JsonObject;
  idempotencyKey?: string;
};

const CARRIED = ["ai", "access_mode", "accessMode", "intent"] as const;

const CONVERSATION = `SELECT c.company_id, co.plan AS company_plan, u.plan AS user_plan,
    (SELECT payload FROM ai_jobs WHERE conversation_id = c.id AND type IN ('chat', 'employer_ai') ORDER BY created_at DESC LIMIT 1) AS last
  FROM conversations c LEFT JOIN companies co ON co.id = c.company_id LEFT JOIN users u ON u.id = $2
  WHERE c.id = $1 AND ((c.company_id IS NULL AND c.user_id = $2) OR (c.company_id IS NOT NULL
    AND c.company_id = (SELECT company_id FROM company_members WHERE user_id = $2)))`;

const LEGACY_INSERT = `WITH job AS (
    INSERT INTO chat_jobs (id, user_id, conversation_id, payload) VALUES ($1, $2, $3, $4::jsonb) RETURNING id
  ) INSERT INTO chat_events (job_id, type, payload) SELECT id, 'status', $5::jsonb FROM job RETURNING job_id`;

/**
 * The payload of the one status row a queued chat job `j` starts with: the first phase of its run.
 * `since` is the job's creation, so a timer counts the whole run. `ahead` is the job's queue position
 * as the bot state defines it (bot_state_v.job_ahead, 0054), so the stream and the bot list say the
 * same number. Outside a bot thread, and once the job runs, it is 0.
 */
export const QUEUED_STATUS = `jsonb_build_object('text', '대기 중', 'phase', 'queued',
    'since', to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'ahead', COALESCE((SELECT v.job_ahead FROM bot_state_v v
      WHERE v.user_id = j.user_id AND v.thread_id = j.conversation_id AND v.job_id = j.id), 0))`;

const STATUS = `INSERT INTO chat_events (job_id, type, payload) SELECT j.id, 'status', ${QUEUED_STATUS} FROM ai_jobs j WHERE j.id = $1`;

const WAITING = JSON.stringify({ text: "대기 중" });

const isJsonObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

const carried = (raw: DbValue): JsonObject => {
  const last: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!isJsonObject(last)) {return {};}
  const entries: Array<[string, Json]> = [];
  for (const key of CARRIED) {
    const value = last[key];
    if (value !== null && value !== undefined) {entries.push([key, value]);}
  }
  return Object.fromEntries(entries);
};

export const enqueueResumeJob = async (ctx: Ctx, job: ResumeJob): Promise<string> => {
  const conversation = await one(ctx.deps.query, CONVERSATION, [job.conversationId, job.userId]);
  if (!conversation) {throw new HttpError(404, "NOT_FOUND", "resource not found");}
  const payload = { ...carried(conversation.last), text: "", ...job.payload };
  const companyId = (conversation.company_id === null || conversation.company_id === undefined) ? undefined : String(conversation.company_id);
  if ((ctx.env.QUEUE_BACKEND || "").trim().toLowerCase() !== "redis") {
    const jobId = crypto.randomUUID();
    await one(ctx.deps.query, LEGACY_INSERT, [jobId, job.userId, job.conversationId, JSON.stringify(payload), WAITING]);
    await scheduleChatJob(ctx, jobId, companyId);
    return jobId;
  }
  const { jobId, queue } = await enqueueJob(ctx.deps.query, {
    type: companyId ? "employer_ai" : "chat",
    userId: job.userId,
    companyId,
    plan: planTier(companyId ? conversation.company_plan : conversation.user_plan),
    payload,
    idempotencyKey: job.idempotencyKey,
    conversationId: job.conversationId,
  }, ctx.deps.transaction);
  await one(ctx.deps.query, STATUS, [jobId]);
  await withDispatcher(ctx.env, ctx.deps.fetch ?? fetch, () => kickDispatcher(queue));
  return jobId;
};
