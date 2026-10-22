import { HttpError } from "../http.ts";

export type JobType = "chat" | "employer_ai" | "document" | "fit" | "ingest" | "notify";

export type QueueName = "q:chat:priority" | "q:chat" | "q:document" | "q:ingest" | "q:notify" | "q:dead";

export type Plan = "FREE" | "BASIC" | "PRO" | "ULTRA";

export type Audience = "PERSONAL" | "EMPLOYER";

export type Gate = "employer_interview" | "pdf_attachment";

const ESTIMATE_MICRO: Record<JobType, bigint> = {
  chat: 60_000n,
  employer_ai: 120_000n,
  document: 80_000n,
  fit: 20_000n,
  ingest: 40_000n,
  notify: 0n,
};

const DEPTH_LIMIT: Record<Plan, number> = {
  FREE: 20,
  BASIC: 40,
  PRO: 200,
  ULTRA: 1000,
};

const MAX_ATTEMPTS: Record<JobType, number> = {
  chat: 4,
  employer_ai: 4,
  document: 3,
  fit: 3,
  ingest: 4,
  notify: 5,
};

const PLAN_RANK: Record<Plan, number> = { FREE: 0, BASIC: 1, PRO: 2, ULTRA: 3 };

const REQUIRED_PLAN: Record<Gate, { plan: Plan; message: string }> = {
  employer_interview: { plan: "PRO", message: "interview requires the PRO plan" },
  pdf_attachment: { plan: "ULTRA", message: "pdf attachments require the ULTRA plan" },
};

export const planTier = (value: unknown): Plan => {
  const raw = value == null ? "" : String(value).trim().toUpperCase();
  if (raw === "BASIC" || raw === "PRO" || raw === "ULTRA" || raw === "FREE") return raw;
  return "FREE";
};

export const assertPlanAllows = (plan: unknown, gate: Gate): void => {
  const need = REQUIRED_PLAN[gate];
  if (PLAN_RANK[planTier(plan)] < PLAN_RANK[need.plan]) {
    throw new HttpError(403, "PLAN_REQUIRED", need.message, { requiredPlan: need.plan });
  }
};

export const estimateMicro = (type: JobType, plan: Plan): bigint => {
  const base = ESTIMATE_MICRO[type];
  if (plan === "ULTRA") return base * 2n;
  if (plan === "PRO") return base + base / 2n;
  return base;
};

export const queueDepthLimit = (plan: Plan): number => DEPTH_LIMIT[plan];

export const maxAttempts = (type: JobType): number => MAX_ATTEMPTS[type];

export const queueFor = (type: JobType, plan: Plan, audience: Audience): QueueName => {
  if (type === "notify") return "q:notify";
  if (type === "ingest") return "q:ingest";
  if (type === "document" || type === "fit") return "q:document";
  const priority = (audience === "EMPLOYER" && (plan === "PRO" || plan === "ULTRA"))
    || (audience === "PERSONAL" && plan === "ULTRA");
  return priority ? "q:chat:priority" : "q:chat";
};

export const RETRY_AFTER_SEC = 30;
