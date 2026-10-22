import { AsyncLocalStorage } from "node:async_hooks";

import type { Query } from "../db.ts";
import { isUnique, one } from "../db.ts";
import { HttpError } from "../http.ts";
import { reserveCredits } from "./credits.ts";
import {
  estimateMicro,
  maxAttempts,
  queueFor,
  type Audience,
  type JobType,
  type Plan,
  type QueueName,
} from "./config.ts";

export { availableMicro } from "./credits.ts";

export type EnqueueInput = {
  type: JobType;
  userId: string;
  companyId?: string;
  plan: Plan;
  payload: unknown;
  idempotencyKey?: string;
  conversationId?: string;
  byok: boolean;
};

const EXISTING = "SELECT id, queue FROM jobs WHERE user_id = $1 AND idempotency_key = $2";

const INSERT_WITH_RESERVE = `WITH ins_job AS (
  INSERT INTO jobs (
    id, type, queue, user_id, company_id, plan, status, attempts, max_attempts,
    payload, idempotency_key, conversation_id
  ) VALUES ($1, $2, $3, $4, $5, $6, 'QUEUED', 0, $7, $8::jsonb, $9, $10)
  RETURNING id, queue
), ins_res AS (
  INSERT INTO credit_reservations (job_id, user_id, company_id, amount_micro, status)
  SELECT id, $4, $5, $11::bigint, 'RESERVED' FROM ins_job
  RETURNING job_id
), ins_out AS (
  INSERT INTO outbox (job_id, queue)
  SELECT id, queue FROM ins_job
  RETURNING job_id
)
SELECT ins_job.id, ins_job.queue FROM ins_job
JOIN ins_res ON ins_res.job_id = ins_job.id
JOIN ins_out ON ins_out.job_id = ins_job.id`;

const INSERT_OPEN = `WITH ins_job AS (
  INSERT INTO jobs (
    id, type, queue, user_id, company_id, plan, status, attempts, max_attempts,
    payload, idempotency_key, conversation_id
  ) VALUES ($1, $2, $3, $4, $5, $6, 'QUEUED', 0, $7, $8::jsonb, $9, $10)
  RETURNING id, queue
), ins_out AS (
  INSERT INTO outbox (job_id, queue)
  SELECT id, queue FROM ins_job
  RETURNING job_id
)
SELECT ins_job.id, ins_job.queue FROM ins_job
JOIN ins_out ON ins_out.job_id = ins_job.id`;

type KickEnv = { origin: string; secret: string; fetchImpl: typeof fetch };

const kickStore = new AsyncLocalStorage<KickEnv>();

const trimOrigin = (value: string | undefined): string => (value || "").trim().replace(/\/+$/, "");

export const withDispatcher = async <T>(
  env: { DISPATCH_ORIGIN?: string; DISPATCH_SECRET?: string },
  fetchImpl: typeof fetch,
  run: () => Promise<T>,
): Promise<T> => kickStore.run({
  origin: trimOrigin(env.DISPATCH_ORIGIN || process.env.DISPATCH_ORIGIN),
  secret: env.DISPATCH_SECRET || process.env.DISPATCH_SECRET || "",
  fetchImpl,
}, run);

export const kickDispatcher = async (queue: QueueName): Promise<void> => {
  const bound = kickStore.getStore();
  const origin = bound?.origin || trimOrigin(process.env.DISPATCH_ORIGIN);
  if (!origin) return;
  const secret = bound?.secret || process.env.DISPATCH_SECRET || "";
  const fetchImpl = bound?.fetchImpl || fetch;
  try {
    const res = await fetchImpl(origin + "/internal/kick", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-push-dispatch-secret": secret,
      },
      body: JSON.stringify({ queue }),
    });
    if (!res.ok) console.error("dispatcher kick failed");
  } catch {
    console.error("dispatcher kick failed");
  }
};

const queued = (row: Record<string, unknown>): { jobId: string; queue: QueueName } => ({
  jobId: String(row.id),
  queue: String(row.queue) as QueueName,
});

export const enqueueJob = async (tx: Query, input: EnqueueInput): Promise<{ jobId: string; queue: QueueName }> => {
  if (input.idempotencyKey) {
    const existing = await one(tx, EXISTING, [input.userId, input.idempotencyKey]);
    if (existing) return queued(existing);
  }
  const audience: Audience = input.companyId ? "EMPLOYER" : "PERSONAL";
  const queue = queueFor(input.type, input.plan, audience);
  const amount = estimateMicro(input.type, input.plan);
  await reserveCredits(tx, {
    userId: input.userId,
    companyId: input.companyId,
    amount,
    byok: input.byok,
  });
  const hold = !input.byok && amount > 0n;
  const params: unknown[] = [
    crypto.randomUUID(),
    input.type,
    queue,
    input.userId,
    input.companyId ?? null,
    input.plan,
    maxAttempts(input.type),
    JSON.stringify(input.payload ?? {}),
    input.idempotencyKey ?? null,
    input.conversationId ?? null,
  ];
  if (hold) params.push(amount.toString());
  try {
    const row = await one(tx, hold ? INSERT_WITH_RESERVE : INSERT_OPEN, params);
    if (!row?.id) throw new HttpError(500, "INTERNAL", "internal error");
    return queued(row);
  } catch (err) {
    if (!isUnique(err) || !input.idempotencyKey) throw err;
    const existing = await one(tx, EXISTING, [input.userId, input.idempotencyKey]);
    if (!existing) throw err;
    return queued(existing);
  }
};
