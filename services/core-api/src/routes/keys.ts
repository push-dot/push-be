import { decryptAes, encryptAes, masterKey } from "../crypto.ts";
import { one, query } from "../db.ts";
import { HttpError, data } from "../http.ts";
import { pageOf, pageResult, ts } from "../page.ts";
import { pageBody } from "../http.ts";
import type { Ctx } from "../types.ts";

const PROVIDERS = new Set(["OPENAI", "OPENROUTER", "CLAUDE", "GEMINI", "GROK"]);

function providerOf(raw: string): string {
  if (!PROVIDERS.has(raw)) throw new HttpError(400, "VALIDATION_ERROR", "unsupported provider", { field: "provider" });
  return raw;
}

function keyDto(row: Record<string, unknown>): Record<string, unknown> {
  return { provider: String(row.provider), lastFour: String(row.last_four), configured: true, updatedAt: ts(row.updated_at) };
}

export async function listKeys(ctx: Ctx): Promise<Response> {
  const rows = await query(ctx.deps.query,
    "SELECT provider, last_four, updated_at FROM ai_keys WHERE user_id = $1 ORDER BY provider",
    [ctx.user.id]);
  return data(200, rows.rows.map(keyDto), ctx.rid);
}

export async function putKey(ctx: Ctx, providerRaw: string): Promise<Response> {
  const provider = providerOf(providerRaw);
  if (!ctx.env.BYOK_MASTER_KEY) throw new HttpError(503, "NOT_CONFIGURED", "BYOK encryption is not configured");
  const raw = await ctx.request.text();
  if (!raw) throw new HttpError(400, "VALIDATION_ERROR", "request body required");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
  if (typeof body.key !== "string") throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  if (body.key.length < 8) throw new HttpError(400, "VALIDATION_ERROR", "key is too short", { field: "key" });
  let key;
  try { key = await masterKey(ctx.env.BYOK_MASTER_KEY); } catch {
    throw new HttpError(503, "NOT_CONFIGURED", "BYOK encryption is not configured");
  }
  const sealed = await encryptAes(key, body.key, ctx.user.id, provider);
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    "INSERT INTO ai_keys (user_id, provider, last_four, ciphertext, nonce, updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, provider) DO UPDATE SET last_four = $3, ciphertext = $4, nonce = $5, updated_at = $6",
    [ctx.user.id, provider, body.key.slice(-4), sealed.ciphertext, sealed.nonce, now]);
  return data(200, { provider, lastFour: body.key.slice(-4), configured: true, updatedAt: ts(now) }, ctx.rid);
}

export async function deleteKey(ctx: Ctx, providerRaw: string): Promise<Response> {
  const provider = providerOf(providerRaw);
  const gone = await one(ctx.deps.query,
    "DELETE FROM ai_keys WHERE user_id = $1 AND provider = $2 RETURNING provider",
    [ctx.user.id, provider]);
  if (!gone) throw new HttpError(404, "NOT_FOUND", "resource not found");
  return new Response(null, { status: 204, headers: { "x-request-id": ctx.rid } });
}

export async function testKey(ctx: Ctx, providerRaw: string): Promise<Response> {
  const provider = providerOf(providerRaw);
  const row = await one(ctx.deps.query, "SELECT provider FROM ai_keys WHERE user_id = $1 AND provider = $2", [ctx.user.id, provider]);
  const now = ts(ctx.now);
  if (!row) return data(200, { valid: false, checkedAt: now, errorCode: "KEY_MISSING" }, ctx.rid);
  return data(200, { valid: false, checkedAt: now, errorCode: "PROVIDER_UNREACHABLE" }, ctx.rid);
}

export async function listUsage(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  let sql = "SELECT id, operation_id, provider, model, managed, input_tokens, output_tokens, cost_micro_credits, status, created_at FROM ai_usage WHERE user_id = $1";
  for (const name of ["from", "to"] as const) {
    const raw = ctx.url.searchParams.get(name);
    if (!raw) continue;
    if (Number.isNaN(Date.parse(raw))) throw new HttpError(400, "VALIDATION_ERROR", "must be RFC3339", { field: name });
    params.push(raw);
    sql += name === "from" ? ` AND created_at >= $${params.length}` : ` AND created_at <= $${params.length}`;
  }
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (created_at, id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({
    item: {
      id: String(row.id),
      operationId: row.operation_id == null ? null : String(row.operation_id),
      provider: String(row.provider),
      model: String(row.model),
      managed: row.managed === true || row.managed === "t",
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      costMicroCredits: Number(row.cost_micro_credits),
      status: String(row.status),
      createdAt: ts(row.created_at),
    },
    createdAt: row.created_at,
    id: String(row.id),
  }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

export async function roundTrip(master: string, userId: string, provider: string, plaintext: string): Promise<string> {
  const key = await masterKey(master);
  const sealed = await encryptAes(key, plaintext, userId, provider);
  return decryptAes(key, sealed.ciphertext, sealed.nonce, userId, provider);
}
