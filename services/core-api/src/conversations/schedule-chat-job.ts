import { HttpError } from "../http.ts";
import type { Ctx } from "../types.ts";

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

// The VPS claims the inserted row. An empty origin is a configuration error.
export const scheduleChatJob = async (ctx: Ctx, jobId: string): Promise<void> => {
  const origin = (ctx.env.AI_ORIGIN || "").trim().replace(/\/+$/, "");
  if (!origin) throw new HttpError(500, "NOT_CONFIGURED", "ai origin is not configured");
  await wakeVps(ctx, origin, jobId);
};
