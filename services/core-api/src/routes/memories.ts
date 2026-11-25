import { isUnique, query } from "../db.ts";
import type { Row } from "../db.ts";
import { HttpError, data, fieldError, noContent, requireUuid } from "../http.ts";
import type { JsonObject } from "../json.ts";
import { ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import { forbidExtra } from "./conversations.ts";
import { readObject, textOf } from "./recruiting-shared.ts";

export const MEMORY_MAX = 300;
const LIST_LIMIT = 200;

const COLS = "id, text, created_at, updated_at";
const LIST = `SELECT ${COLS} FROM user_memories WHERE user_id = $1 ORDER BY updated_at DESC, id LIMIT ${LIST_LIMIT}`;
// Correcting a memory into one the user already has (unique on user_id, text) folds this row into that one.
const UPDATE = `WITH own AS (SELECT id FROM user_memories WHERE id = $1 AND user_id = $2),
  dup AS (SELECT m.id FROM user_memories m WHERE m.user_id = $2 AND m.text = $3 AND m.id <> $1 AND EXISTS (SELECT 1 FROM own)),
  gone AS (DELETE FROM user_memories WHERE id = $1 AND user_id = $2 AND EXISTS (SELECT 1 FROM dup) RETURNING id),
  kept AS (UPDATE user_memories SET updated_at = $4 WHERE id = (SELECT id FROM dup) AND EXISTS (SELECT 1 FROM gone) RETURNING ${COLS}),
  changed AS (UPDATE user_memories SET text = $3, updated_at = $4 WHERE id = $1 AND user_id = $2 AND NOT EXISTS (SELECT 1 FROM dup) RETURNING ${COLS})
  SELECT * FROM kept UNION ALL SELECT * FROM changed`;
const DELETE = "DELETE FROM user_memories WHERE id = $1 AND user_id = $2";
const CLEAR = "DELETE FROM user_memories WHERE user_id = $1";

const memoryDto = (row: Row): JsonObject => ({
  id: String(row.id),
  text: String(row.text),
  createdAt: ts(row.created_at),
  updatedAt: ts(row.updated_at),
});

const notFound = (): HttpError => new HttpError(404, "NOT_FOUND", "resource not found");

const listMemories = async (ctx: Ctx): Promise<Response> => {
  const rows = await query(ctx.deps.query, LIST, [ctx.user.id]);
  return data(200, rows.rows.map(memoryDto), ctx.rid);
};

const patchMemory = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const body = await readObject(ctx.request);
  forbidExtra(body, ["text"]);
  const text = textOf(body.text, "text", 1, MEMORY_MAX).trim();
  if (!text) {throw fieldError("text", "must not be blank");}
  let rows;
  try {
    rows = await query(ctx.deps.query, UPDATE, [id, ctx.user.id, text, ctx.now.toISOString()]);
  } catch (error) {
    // A concurrent edit wrote the same text between the read and the write.
    if (isUnique(error)) {throw new HttpError(409, "CONFLICT", "a memory with this text already exists");}
    throw error;
  }
  const row = rows.rows[0];
  if (!row) {throw notFound();}
  return data(200, memoryDto(row), ctx.rid);
};

const deleteMemory = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const gone = await query(ctx.deps.query, DELETE, [requireUuid(idRaw, "id"), ctx.user.id]);
  if (gone.rowCount === 0) {throw notFound();}
  return noContent(ctx.rid);
};

const clearMemories = async (ctx: Ctx): Promise<Response> => {
  await query(ctx.deps.query, CLEAR, [ctx.user.id]);
  return noContent(ctx.rid);
};

export const dispatchMemories = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (path === "/api/v1/me/memories" && method === "GET") {return listMemories(ctx);}
  if (path === "/api/v1/me/memories" && method === "DELETE") {return clearMemories(ctx);}
  const item = path.match(/^\/api\/v1\/me\/memories\/([^/]+)$/);
  if (item && method === "PATCH") {return patchMemory(ctx, item[1]);}
  if (item && method === "DELETE") {return deleteMemory(ctx, item[1]);}
  return null;
};
