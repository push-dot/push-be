import { one, query } from "../db.ts";
import { HttpError, asBool, data, fieldError } from "../http.ts";
import { ts } from "../page.ts";
import type { Ctx } from "../types.ts";

const PATH = "/api/v1/me/consents";

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  const raw = await request.text();
  if (!raw) throw new HttpError(400, "VALIDATION_ERROR", "request body required");
  try {
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
    }
    return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
};

const view = (referenceData: boolean, updatedAt: string | null) => ({ referenceData, updatedAt });

const getConsents = async (ctx: Ctx): Promise<Response> => {
  const row = await one(ctx.deps.query,
    "SELECT reference_data, updated_at FROM user_consents WHERE user_id = $1",
    [ctx.user.id]);
  if (!row) return data(200, view(false, null), ctx.rid);
  return data(200, view(asBool(row.reference_data), ts(row.updated_at)), ctx.rid);
};

const putConsents = async (ctx: Ctx): Promise<Response> => {
  const body = await readJson(ctx.request);
  if (typeof body.referenceData !== "boolean") throw fieldError("referenceData", "must be a boolean");
  const now = ctx.now.toISOString();
  if (!body.referenceData) {
    await query(ctx.deps.query, "DELETE FROM reference_samples WHERE source_user_id = $1", [ctx.user.id]);
  }
  await query(ctx.deps.query,
    "INSERT INTO user_consents (user_id, reference_data, updated_at) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET reference_data = EXCLUDED.reference_data, updated_at = EXCLUDED.updated_at",
    [ctx.user.id, body.referenceData, now]);
  return data(200, view(body.referenceData, ts(now)), ctx.rid);
};

export const dispatchConsents = async (ctx: Ctx, path: string): Promise<Response | null> => {
  if (path !== PATH) return null;
  if (ctx.request.method === "GET") return getConsents(ctx);
  if (ctx.request.method === "PUT") return putConsents(ctx);
  return null;
};
