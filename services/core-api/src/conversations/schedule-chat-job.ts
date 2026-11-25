import { HttpError } from "../http.ts";
import type { Ctx } from "../types.ts";

async function wakeVps(ctx: Ctx, origin: string, jobId: string): Promise<void> {
  const fetchImpl = ctx.deps.fetch ?? fetch;
  const base = {
    "content-type": "application/json",
    "x-push-internal": "1",
    "x-request-id": ctx.rid,
  };
  const secret = (ctx.env.AI_SHARED_SECRET || "").trim();
  const headers = secret ? { ...base, "x-push-ai-secret": secret } : base;
  try {
    const scheduled = await fetchImpl(origin + "/internal/chat/schedule", {
      method: "POST",
      headers,
      body: JSON.stringify({ jobId }),
    });
    if (!scheduled.ok) {console.error("vps chat wake failed", scheduled.status);}
  } catch {
    console.error("vps chat wake failed");
  }
}

const originOf = (value: string | undefined): string => (value || "").trim().replace(/\/+$/, "");

// The VPS claims the inserted row. An empty origin is a configuration error.
// A company conversation's job belongs to push-agent; without AGENT_ORIGIN the wake goes to push-bot and push-agent's own poll claims it.
export const scheduleChatJob = async (ctx: Ctx, jobId: string, companyId?: string): Promise<void> => {
  const origin = (companyId ? originOf(ctx.env.AGENT_ORIGIN) : "") || originOf(ctx.env.AI_ORIGIN);
  if (!origin) {throw new HttpError(500, "NOT_CONFIGURED", "ai origin is not configured");}
  await wakeVps(ctx, origin, jobId);
};
