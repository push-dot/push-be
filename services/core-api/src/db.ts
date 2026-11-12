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

/** 55P03: lock_timeout ran out while waiting for a row lock. */
export const isLockTimeout = (err: unknown): boolean => {
  const e = err as { code?: string; message?: string };
  return e?.code === "55P03" || /55P03|lock timeout/i.test(`${e?.message || ""} ${String(err)}`);
};

export const isMissingRelation = (err: unknown): boolean => {
  const e = err as { code?: string; message?: string };
  return e?.code === "42P01" || /42P01|relation .* does not exist/i.test(`${e?.message || ""} ${String(err)}`);
};

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

/** Runs `work` in one interactive transaction; a throw rolls it back. */
export interface Transaction {
  <T>(work: (q: Query) => Promise<T>): Promise<T>;
}

type Session = { query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> };

export const inTransaction = async <T>(session: Session, work: (q: Query) => Promise<T>): Promise<T> => {
  await session.query("BEGIN");
  try {
    const out = await work(async (text, params = []) => {
      const result = await session.query(text, params);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? result.rows.length };
    });
    await session.query("COMMIT");
    return out;
  } catch (err) {
    await session.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
};
