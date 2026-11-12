import { one, query } from "../db.ts";
import { HttpError, fieldError, noContent, pageBody, requireUuid } from "../http.ts";
import { pageOf, pageResult, ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import { notFound, readObject, countWhere, person } from "./recruiting-shared.ts";

async function blockUser(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  if (typeof body.userId !== "string") throw fieldError("userId", "must be a UUID");
  const id = requireUuid(body.userId, "userId");
  if (id === ctx.user.id) throw new HttpError(400, "VALIDATION_ERROR", "cannot block yourself", { field: "userId" });
  const user = await one(ctx.deps.query, "SELECT id FROM users WHERE id = $1", [id]);
  if (!user) throw notFound();
  await query(ctx.deps.query,
    "INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES ($1,$2,$3) ON CONFLICT (blocker_id, blocked_id) DO NOTHING",
    [ctx.user.id, id, ctx.now.toISOString()]);
  return noContent(ctx.rid);
}

async function unblockUser(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "userId");
  await query(ctx.deps.query, "DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2", [ctx.user.id, id]);
  return noContent(ctx.rid);
}

async function listBlocks(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  let sql = "SELECT b.blocked_id, u.display_name, b.created_at FROM user_blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = $1";
  const total = await countWhere(ctx, sql, " FROM user_blocks b", params.slice());
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (b.created_at, b.blocked_id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY b.created_at DESC, b.blocked_id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({
    item: { user: person(row, "blocked_id", "display_name"), createdAt: ts(row.created_at) },
    createdAt: row.created_at,
    id: String(row.blocked_id),
  }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid, total);
}

export const dispatchBlocks = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (path === "/api/v1/me/blocks" && method === "POST") return blockUser(ctx);
  if (path === "/api/v1/me/blocks" && method === "GET") return listBlocks(ctx);
  const blocked = path.match(/^\/api\/v1\/me\/blocks\/([^/]+)$/);
  if (blocked && method === "DELETE") return unblockUser(ctx, blocked[1]);
  return null;
};
