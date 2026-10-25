import { one, query, type Query } from "./db.ts";
import { HttpError, fieldError, pageBody, parseUuid } from "./http.ts";
import { decodeCursor, encodeCursor, formatJsonTimestamp } from "./time.ts";

export interface Page {
  limit: number;
  cursor: { createdAt: string; id: string } | null;
}

export function pageOf(url: URL): Page {
  const raw = url.searchParams.get("limit");
  let limit = 50;
  if (raw) {
    if (!/^[1-9]\d*$/.test(raw)) throw fieldError("limit", "must be a positive integer");
    limit = Math.min(Number(raw), 100);
  }
  const encoded = url.searchParams.get("cursor");
  if (!encoded) return { limit, cursor: null };
  let cursor: { createdAt: string; id: string };
  try {
    cursor = decodeCursor(encoded);
  } catch {
    throw fieldError("cursor", "invalid cursor");
  }
  const id = parseUuid(cursor.id);
  if (!id) throw fieldError("cursor", "invalid cursor");
  return { limit, cursor: { createdAt: cursor.createdAt, id } };
}

export function pageResult<T>(items: T[], limit: number, cursorOf: (item: T) => { createdAt: unknown; id: string }): {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
} {
  let hasMore = false;
  let nextCursor: string | null = null;
  let slice = items;
  if (items.length > limit) {
    slice = items.slice(0, limit);
    hasMore = true;
    const last = slice[slice.length - 1];
    const cur = cursorOf(last);
    nextCursor = encodeCursor(cur.createdAt, cur.id);
  }
  return { items: slice, nextCursor, hasMore };
}

export function ts(value: unknown): string | null {
  if (value == null || value === "") return null;
  return formatJsonTimestamp(value);
}

export async function revisionUpdate(
  q: Query,
  table: string,
  sql: string,
  params: unknown[],
  id: string,
  userId: string,
): Promise<Record<string, unknown>> {
  const updated = await one(q, sql, params);
  if (updated) return updated;
  const current = await one(q, `SELECT revision FROM ${table} WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!current) throw new HttpError(404, "NOT_FOUND", "resource not found");
  throw new HttpError(409, "REVISION_CONFLICT", "resource was modified", {
    currentRevision: Number(current.revision),
  });
}

type Row = Record<string, unknown>;

/** Keyset page over `(created_at, id)`, newest first, as the Python stores list. */
export const listPage = async (
  q: Query, rid: string, cols: string, table: string, where: string[], params: unknown[], page: Page, dto: (row: Row) => Row,
): Promise<Response> => {
  const args = [...params];
  const conds = [...where];
  if (page.cursor) {
    args.push(page.cursor.createdAt, page.cursor.id);
    conds.push(`(created_at, id) < ($${args.length - 1}, $${args.length})`);
  }
  args.push(page.limit + 1);
  const rows = await query(q,
    `SELECT ${cols} FROM ${table} WHERE ${conds.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${args.length}`, args);
  const paged = pageResult(rows.rows, page.limit, (row) => ({ createdAt: row.created_at, id: String(row.id) }));
  return pageBody(paged.items.map(dto), paged.nextCursor, paged.hasMore, rid);
};
