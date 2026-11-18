import { query } from "../db.ts";
import { enqueueJob, kickDispatcher, withDispatcher } from "../jobs/enqueue.ts";
import type { Ctx } from "../types.ts";
import { deliverPush } from "./notifier.ts";

export type Notice = {
  userId: string;
  type: string;
  title: string;
  body: string;
  target: Record<string, unknown>;
  conversationId?: string;
  pushBody?: string;
};

const queued = (ctx: Ctx): boolean => (ctx.env.QUEUE_BACKEND || "").trim().toLowerCase() === "redis";

export const sendNotification = async (ctx: Ctx, notice: Notice): Promise<string> => {
  const id = crypto.randomUUID();
  const payload: Record<string, unknown> = {
    notificationId: id,
    userId: notice.userId,
    kind: notice.type,
    title: notice.title,
    body: notice.body,
    target: notice.target,
    createdAt: ctx.now.toISOString(),
  };
  if (notice.pushBody != null) payload.pushBody = notice.pushBody;
  if (notice.conversationId != null) payload.conversationId = notice.conversationId;
  if (queued(ctx)) {
    await enqueueJob(ctx.deps.query, {
      type: "notify",
      userId: notice.userId,
      plan: "FREE",
      payload,
      conversationId: notice.conversationId,
    });
    await withDispatcher(ctx.env, ctx.deps.fetch ?? fetch, () => kickDispatcher("q:notify"));
    return id;
  }
  await query(ctx.deps.query,
    "INSERT INTO notifications (id, user_id, type, title, body, target, read_at, created_at, conversation_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,NULL,$7,$8)",
    [id, notice.userId, notice.type, notice.title, notice.body, JSON.stringify(notice.target), ctx.now.toISOString(), notice.conversationId ?? null]);
  await deliverPush(ctx, notice.userId, notice.title, notice.pushBody ?? notice.body, notice.target);
  return id;
};
