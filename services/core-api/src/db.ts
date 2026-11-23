import type { Json } from "./json.ts";

/** A column value as the Neon driver decodes it: timestamps stay strings (index.ts), `date` is a Date, bytea a Buffer. */
export type DbValue = Json | Date | Uint8Array;

export type Row = Record<string, DbValue>;

export interface QueryResult {
  rows: Array<Row>;
  rowCount: number;
}

export interface Query {
  (text: string, params?: Array<unknown>): Promise<QueryResult>;
}

export const errorInfo = (err: unknown) => {
  const object = typeof err === "object" && err !== null ? err : undefined;
  const code = object && "code" in object && typeof object.code === "string" ? object.code : undefined;
  const message = object && "message" in object && typeof object.message === "string" ? object.message : undefined;
  return { code, message };
};

// The driver decodes every column to a DbValue; this guard only drops non-object rows.
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null;

export function isUnique(err: unknown): boolean {
  const e = errorInfo(err);
  const text = `${e?.code || ""} ${e?.message || ""} ${String(err)}`;
  return e?.code === "23505" || /23505|duplicate key|unique constraint/i.test(text);
}

/** 42703: a column the code expects is not migrated yet. */
export function isUndefinedColumn(err: unknown): boolean {
  const e = errorInfo(err);
  return e?.code === "42703" || /42703|column .* does not exist/i.test(`${e?.message || ""} ${String(err)}`);
}

export const namesUndefinedColumn = (err: unknown, column: string): boolean => {
  const e = errorInfo(err);
  return isUndefinedColumn(err) && `${e?.message ?? ""} ${String(err)}`.includes(column);
};

export async function withCalendar<T>(run: (calendar: boolean) => Promise<T>): Promise<T> {
  try {
    return await run(true);
  } catch (error) {
    if (!namesUndefinedColumn(error, "posting_id")) {throw error;}
    return run(false);
  }
}

/** 55P03: lock_timeout ran out while waiting for a row lock. */
export const isLockTimeout = (err: unknown): boolean => {
  const e = errorInfo(err);
  return e?.code === "55P03" || /55P03|lock timeout/i.test(`${e?.message || ""} ${String(err)}`);
};

export const isMissingRelation = (err: unknown): boolean => {
  const e = errorInfo(err);
  return e?.code === "42P01" || /42P01|relation .* does not exist/i.test(`${e?.message || ""} ${String(err)}`);
};

export async function query(q: Query, text: string, params: Array<unknown> = []): Promise<QueryResult> {
  const result = await q(text, params);
  return {
    rows: result.rows || [],
    rowCount: result.rowCount ?? (result.rows || []).length,
  };
}

export async function one(q: Query, text: string, params: Array<unknown> = []): Promise<Row | null> {
  const result = await query(q, text, params);
  return result.rows[0] ?? null;
}

/** Runs `work` in one interactive transaction; a throw rolls it back. */
export interface Transaction {
  <T>(work: (q: Query) => Promise<T>): Promise<T>;
}

type Session = { query(text: string, params?: Array<unknown>): Promise<{ rows: Array<unknown>; rowCount: number | null }> };

export const inTransaction = async <T>(session: Session, work: (q: Query) => Promise<T>): Promise<T> => {
  await session.query("BEGIN");
  try {
    const out = await work(async (text, params = []) => {
      const result = await session.query(text, params);
      return { rows: result.rows.filter(isRow), rowCount: result.rowCount ?? result.rows.length };
    });
    await session.query("COMMIT");
    return out;
  } catch (error) {
    await session.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
};
