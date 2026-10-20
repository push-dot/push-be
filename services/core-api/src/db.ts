export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface Query {
  (text: string, params?: unknown[]): Promise<QueryResult>;
}

export function isUnique(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  const text = `${e?.code || ""} ${e?.message || ""} ${String(err)}`;
  return e?.code === "23505" || /23505|duplicate key|unique constraint/i.test(text);
}

/** 42703: a column the code expects is not migrated yet. */
export function isUndefinedColumn(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "42703" || /42703|column .* does not exist/i.test(`${e?.message || ""} ${String(err)}`);
}

export async function query(q: Query, text: string, params: unknown[] = []): Promise<QueryResult> {
  const result = await q(text, params);
  return {
    rows: result.rows || [],
    rowCount: result.rowCount ?? (result.rows || []).length,
  };
}

export async function one(q: Query, text: string, params: unknown[] = []): Promise<Record<string, unknown> | null> {
  const result = await query(q, text, params);
  return result.rows[0] ?? null;
}
