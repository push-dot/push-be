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

type Multipart = { fields?: Record<string, string>; file?: { name: string; type: string; base64: string } | null };
type Case = { name: string; method: string; path: string; body: unknown; auth?: boolean; ignoreKeys?: string[]; sql?: string; sortKeys?: boolean };
type Golden = { name: string; status: number; body?: unknown; contentType?: string; base64?: string; location?: string };
type HttpRule = { method: string; url: string; status?: number; body?: unknown };
type Logged = { sql: string; rows?: Record<string, unknown>[]; rowCount?: number; error?: { code?: string; message: string } };

const read = <T>(file: string): T => JSON.parse(readFileSync(resolve(DIR, file), "utf8")) as T;

const idempotencyKey = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const knownIds = (group: string): Set<string> => {
  const text = readFileSync(resolve(DIR, "seed.sql"), "utf8") + readFileSync(resolve(DIR, `${group}.cases.json`), "utf8");
  return new Set([...(text.match(UUID) || []), ...(text.match(HEX_KEY) || [])].map((id) => id.toLowerCase())
    .concat(text.match(TOKEN) || []));
};

const HEX_KEY = /\b[0-9a-f]{32}\b/g;
const TOKEN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

const normalize = (value: unknown, known: Set<string>): unknown => {
  if (typeof value === "string") {
    if (value.startsWith("invalid request body")) return "invalid request body";
    return value
      .replace(UUID, (id) => (known.has(id.toLowerCase()) ? id : "<new-uuid>"))
      .replace(HEX_KEY, (key) => (known.has(key) ? key : "<new-key>"))
      .replace(TOKEN, (token) => (known.has(token) ? token : "<token>"));
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

/** For answers built from an unordered GROUP BY: compare without key order. */
const sortedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
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

const requestBody = (body: unknown, headers: Record<string, string>): BodyInit | undefined => {
  if (body === null || body === undefined) return undefined;
  const multipart = (body as { multipart?: Multipart }).multipart;
  if (!multipart) {
    headers["content-type"] = "application/json";
    return JSON.stringify(body);
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(multipart.fields || {})) form.set(key, value);
  if (multipart.file) {
    const bytes = Buffer.from(multipart.file.base64, "base64");
    form.set("file", new File([bytes], multipart.file.name, { type: multipart.file.type }));
  }
  return form;
};

const drop = (value: unknown, keys: string[] = []): unknown => {
  const inner = (value as { data?: Record<string, unknown> } | null)?.data;
  if (!keys.length || !inner || typeof inner !== "object") return value;
  return { ...(value as object), data: Object.fromEntries(Object.entries(inner).filter(([key]) => !keys.includes(key))) };
};

const fakeFetch = (rules: HttpRule[]): typeof fetch => async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const rule = rules.find((r) => r.method === method && url.startsWith(r.url));
  if (!rule) return new Response(JSON.stringify({ error: "no parity rule for " + url }), { status: 599 });
  return new Response(JSON.stringify(rule.body ?? null), { status: rule.status ?? 200, headers: { "content-type": "application/json" } });
};

const expected = (golden: Golden, known: Set<string>, ignore?: string[]): string => {
  if (golden.location !== undefined) return JSON.stringify(normalize({ location: golden.location }, known));
  if (golden.base64 !== undefined) return JSON.stringify({ contentType: golden.contentType, base64: golden.base64 });
  return JSON.stringify(normalize(drop(golden.body ?? null, ignore), known));
};

const actual = async (res: Response, known: Set<string>, ignore?: string[]): Promise<string> => {
  if (res.status >= 300 && res.status < 400) return JSON.stringify(normalize({ location: res.headers.get("location") }, known));
  const kind = res.headers.get("content-type") || "";
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length && !kind.startsWith("application/json")) return JSON.stringify({ contentType: kind, base64: bytes.toString("base64") });
  return JSON.stringify(normalize(drop(bytes.length ? JSON.parse(bytes.toString("utf8")) : null, ignore), known));
};

export const parityGroup = async (group: string, base: CoreEnv = { APP_ENV: "production" }): Promise<{ ran: boolean; mismatches: string[] }> => {
  const cases = read<Case[]>(`${group}.cases.json`);
  const env: CoreEnv = existsSync(resolve(DIR, `${group}.env.json`)) ? { ...base, ...read<CoreEnv>(`${group}.env.json`) } : base;
  const fetchImpl = existsSync(resolve(DIR, `${group}.http.json`)) ? fakeFetch(read<HttpRule[]>(`${group}.http.json`)) : undefined;
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
      if (item.sql) {
        const result = await query(item.sql);
        const rows = result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v == null ? null : String(v)])));
        const got = JSON.stringify(normalize(rows, known));
        const want = JSON.stringify(normalize(golden[index].body, known));
        if (got !== want) mismatches.push(`${item.name}: rows differ\n  core:   ${got}\n  python: ${want}`);
        continue;
      }
      const headers: Record<string, string> = { "x-request-id": "parity" };
      if (item.auth !== false) headers.authorization = "Bearer parity-token";
      if (["POST", "PATCH", "PUT"].includes(item.method)) headers["idempotency-key"] = idempotencyKey(index);
      const res = await handle(new Request("http://testserver" + item.path, {
        method: item.method,
        headers,
        body: requestBody(item.body, headers),
      }), env, { query, now: () => NOW, fetch: fetchImpl });
      const order = (text: string): string => (item.sortKeys ? JSON.stringify(sortedKeys(JSON.parse(text))) : text);
      const want = order(expected(golden[index], known, item.ignoreKeys));
      const got = order(await actual(res, known, item.ignoreKeys));
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
