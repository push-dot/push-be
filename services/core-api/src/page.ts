import { one, type Query } from "./db.ts";
import { fieldError, type HttpError } from "./http.ts";
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
  const cur = url.searchParams.get("cursor");
  if (!cur) return { limit, cursor: null };
  try {
    return { limit, cursor: decodeCursor(cur) };
  } catch {
    throw fieldError("cursor", "invalid cursor");
  }
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

export function idOf(value: unknown): string {
  return String(value);
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
  if (!current) {
    const { HttpError } = await import("./http.ts");
    throw new HttpError(404, "NOT_FOUND", "resource not found");
  }
  const { HttpError } = await import("./http.ts");
  throw new HttpError(409, "REVISION_CONFLICT", "resource was modified", {
    currentRevision: Number(current.revision),
  });
}

export function notFound(): HttpError {
  return fieldError("id", "must be a UUID");
}
