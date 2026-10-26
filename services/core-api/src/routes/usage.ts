import { query } from "../db.ts";
import { HttpError } from "../http.ts";
import { pageOf, pageResult, ts } from "../page.ts";
import { pageBody } from "../http.ts";
import type { Ctx } from "../types.ts";

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
