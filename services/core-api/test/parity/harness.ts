import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Query, QueryResult } from "../../src/db.ts";
import { handle, type CoreEnv } from "../../src/handler.ts";
import { resetLimits } from "../../src/ratelimit.ts";

const DIR = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-10-22T12:00:00Z");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

type Case = { name: string; method: string; path: string; body: unknown };
type Golden = { name: string; status: number; body: unknown };
type Logged = { sql: string; rows?: Record<string, unknown>[]; rowCount?: number; error?: { code?: string; message: string } };

const read = <T>(file: string): T => JSON.parse(readFileSync(resolve(DIR, file), "utf8")) as T;

const idempotencyKey = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const knownIds = (group: string): Set<string> => {
  const text = readFileSync(resolve(DIR, "seed.sql"), "utf8") + readFileSync(resolve(DIR, `${group}.cases.json`), "utf8");
  return new Set((text.match(UUID) || []).map((id) => id.toLowerCase()));
};

const normalize = (value: unknown, known: Set<string>): unknown => {
  if (typeof value === "string") {
    if (value.startsWith("invalid request body")) return "invalid request body";
    return value.replace(UUID, (id) => (known.has(id.toLowerCase()) ? id : "<new-uuid>"));
  }
  if (Array.isArray(value)) return sortNewTies(value.map((item) => normalize(item, known)));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, known)]));
  }
  return value;
};

const tieKey = (item: unknown): string | null => {
  const row = item as { id?: unknown; createdAt?: unknown } | null;
  return row && row.id === "<new-uuid>" && typeof row.createdAt === "string" ? row.createdAt : null;
};

/** Rows created in the same instant are ordered by random ids on both sides; sort only those runs. */
const sortNewTies = (items: unknown[]): unknown[] => {
  const out = [...items];
  let start = 0;
  while (start < out.length) {
    const key = tieKey(out[start]);
    let end = start + 1;
    while (key !== null && end < out.length && tieKey(out[end]) === key) end += 1;
    if (end - start > 1) {
      const run = out.slice(start, end).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      out.splice(start, run.length, ...run);
    }
    start = end;
  }
  return out;
};

const replay = (log: Logged[][], caseIndex: () => number): Query => {
  const cursors = new Map<number, number>();
  return async (sql: string): Promise<QueryResult> => {
    const index = caseIndex();
    const at = cursors.get(index) ?? 0;
    cursors.set(index, at + 1);
    const entry = log[index]?.[at];
    assert.ok(entry, `case ${index}: no recorded result for query #${at}: ${sql.slice(0, 120)}`);
    assert.equal(sql, entry.sql, `case ${index}: query #${at} changed; re-record with PARITY_PG_URL and PARITY_RECORD=1`);
    if (entry.error) throw Object.assign(new Error(entry.error.message), { code: entry.error.code });
    return { rows: structuredClone(entry.rows || []), rowCount: entry.rowCount ?? (entry.rows || []).length };
  };
};

const recording = (live: Query, log: Logged[][], caseIndex: () => number): Query => async (sql, params = []) => {
  const index = caseIndex();
  log[index] ||= [];
  try {
    const result = await live(sql, params);
    log[index].push({ sql, rows: structuredClone(result.rows), rowCount: result.rowCount });
    return result;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    log[index].push({ sql, error: { code: e.code, message: String(e.message) } });
    throw err;
  }
};

export const parityGroup = async (group: string, env: CoreEnv = { APP_ENV: "production" }): Promise<{ ran: boolean; mismatches: string[] }> => {
  const cases = read<Case[]>(`${group}.cases.json`);
  const golden = read<Golden[]>(`${group}.golden.json`);
  const queriesFile = `${group}.queries.json`;
  const url = process.env.PARITY_PG_URL;
  if (!url && !existsSync(resolve(DIR, queriesFile))) return { ran: false, mismatches: [] };
  let current = 0;
  const log: Logged[][] = [];
  let query: Query;
  let close = async () => {};
  if (url) {
    const { livePg } = await import("./pg.ts");
    const pg = await livePg(url);
    close = pg.close;
    try {
      await pg.query(readFileSync(resolve(DIR, "seed.sql"), "utf8"));
    } catch (err) {
      await close();
      throw err;
    }
    query = recording(pg.query, log, () => current);
  } else {
    query = replay(read<Logged[][]>(queriesFile), () => current);
  }
  const known = knownIds(group);
  const mismatches: string[] = [];
  try {
    for (const [index, item] of cases.entries()) {
      current = index;
      resetLimits();
      const headers: Record<string, string> = { authorization: "Bearer parity-token", "x-request-id": "parity" };
      if (["POST", "PATCH", "PUT"].includes(item.method)) headers["idempotency-key"] = idempotencyKey(index);
      if (item.body !== null && item.body !== undefined) headers["content-type"] = "application/json";
      const res = await handle(new Request("https://core.example" + item.path, {
        method: item.method,
        headers,
        body: item.body === null || item.body === undefined ? undefined : JSON.stringify(item.body),
      }), env, { query, now: () => NOW });
      const text = await res.text();
      const got = JSON.stringify(normalize(text ? JSON.parse(text) : null, known));
      const want = JSON.stringify(normalize(golden[index].body, known));
      if (res.status !== golden[index].status || got !== want) {
        mismatches.push(`${item.name}: status ${res.status} vs ${golden[index].status}\n  core:   ${got}\n  python: ${want}`);
      }
    }
  } finally {
    await close();
  }
  if (url && process.env.PARITY_RECORD === "1") {
    writeFileSync(resolve(DIR, queriesFile), JSON.stringify(log) + "\n");
  }
  return { ran: true, mismatches };
};
