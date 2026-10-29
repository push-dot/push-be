import type { Ctx } from "../types.ts";
import { enqueueJob, kickDispatcher, withDispatcher } from "./enqueue.ts";

export const enqueueIngest = async (ctx: Ctx, payload: Record<string, string>): Promise<void> => {
  await enqueueJob(ctx.deps.query, {
    type: "ingest",
    userId: ctx.user.id,
    plan: "FREE",
    payload,
  });
  await withDispatcher(ctx.env, ctx.deps.fetch ?? fetch, () => kickDispatcher("q:ingest"));
};
