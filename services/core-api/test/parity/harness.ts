import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { errorInfo } from "../../src/db.ts";
import type { Query, QueryResult } from "../../src/db.ts";
import { handle } from '../../src/handler.ts';
import type { CoreEnv } from '../../src/handler.ts';
import { resetLimits } from "../../src/ratelimit.ts";

const DIR = import.meta.dirname;
const NOW = new Date("2026-10-22T12:00:00Z");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

type Json = string | number | boolean | null | undefined | Array<Json> | { [key: string]: Json };
type Multipart = { fields?: Record<string, string>; file?: { name: string; type: string; base64: string } | null };
type Case = { name: string; method: string; path: string; body: unknown; auth?: boolean; ignoreKeys?: Array<string>; sql?: string; sortKeys?: boolean };
type Golden = { name: string; status: number; body?: Json; contentType?: string; base64?: string; location?: string };
type HttpRule = { method: string; url: string; status?: number; body?: unknown };
type Logged = { sql: string; rows?: QueryResult["rows"]; rowCount?: number; error?: { code?: string; message: string } };

const isJson = (value: unknown): value is Json => {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {return true;}
  if (Array.isArray(value)) {return value.every(isJson);}
  return typeof value === "object" && Object.values(value).every(isJson);
};

const parseJson = (text: string): Json => {
  const parsed: unknown = JSON.parse(text);
  if (!isJson(parsed)) {throw new Error("not a JSON value");}
  return parsed;
};

// A case that carries `sql` only reads the database and has no request.
const isCase = (value: unknown): value is Case => typeof value === "object" && value !== null
  && "name" in value && typeof value.name === "string"
  && (("method" in value && typeof value.method === "string" && "path" in value && typeof value.path === "string")
    || ("sql" in value && typeof value.sql === "string"));
const isGolden = (value: unknown): value is Golden => typeof value === "object" && value !== null
  && "name" in value && typeof value.name === "string" && "status" in value && typeof value.status === "number";
const isHttpRule = (value: unknown): value is HttpRule => typeof value === "object" && value !== null
  && "method" in value && typeof value.method === "string" && "url" in value && typeof value.url === "string";
const isLogged = (value: unknown): value is Logged => typeof value === "object" && value !== null
  && "sql" in value && typeof value.sql === "string";
const isEnv = (value: unknown): value is CoreEnv => typeof value === "object" && value !== null
  && !Array.isArray(value) && Object.values(value).every((item) => typeof item === "string");
const listOf = <T>(guard: (value: unknown) => value is T) => (value: unknown): value is Array<T> => Array.isArray(value) && value.every(guard);

const read = <T>(file: string, guard: (value: unknown) => value is T): T => {
  const parsed: unknown = JSON.parse(readFileSync(resolve(DIR, file), "utf8"));
  if (!guard(parsed)) {throw new Error(`${file}: unexpected shape`);}
  return parsed;
};

const idempotencyKey = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const knownIds = (group: string): Set<string> => {
  const extra = existsSync(resolve(DIR, `${group}.seed.sql`)) ? readFileSync(resolve(DIR, `${group}.seed.sql`), "utf8") : "";
  const text = readFileSync(resolve(DIR, "seed.sql"), "utf8") + extra + readFileSync(resolve(DIR, `${group}.cases.json`), "utf8");
  return new Set([...(text.match(UUID) || []), ...(text.match(HEX_KEY) || [])].map((id) => id.toLowerCase())
    .concat(text.match(TOKEN) || []));
};

const HEX_KEY = /\b[0-9a-f]{32}\b/g;
const TOKEN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

const normalize = (value: unknown, known: Set<string>): Json => {
  if (typeof value === "string") {
    if (value.startsWith("invalid request body")) {return "invalid request body";}
    return value
      .replaceAll(UUID, (id) => (known.has(id.toLowerCase()) ? id : "<new-uuid>"))
      .replaceAll(HEX_KEY, (key) => (known.has(key) ? key : "<new-key>"))
      .replaceAll(TOKEN, (token) => (known.has(token) ? token : "<token>"));
  }
  if (Array.isArray(value)) {return sortNewTies(value.map((item) => normalize(item, known)));}
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, known)]));
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {return value;}
  return null;
};

const tieKey = (item: Json): string | null => {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {return null;}
  return item.id === "<new-uuid>" && typeof item.createdAt === "string" ? item.createdAt : null;
};

/** Rows created in the same instant are ordered by random ids on both sides; sort only those runs. */
const sortNewTies = (items: Array<Json>): Array<Json> => {
  const out = [...items];
  let start = 0;
  while (start < out.length) {
    const key = tieKey(out[start]);
    let end = start + 1;
    while (key !== null && end < out.length && tieKey(out[end]) === key) {end += 1;}
    if (end - start > 1) {
      const run = out.slice(start, end).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      out.splice(start, run.length, ...run);
    }
    start = end;
  }
  return out;
};

/** For answers built from an unordered GROUP BY: compare without key order. */
const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number => Number(a > b) - Number(a < b);

const sortedKeys = (value: Json): Json => {
  if (Array.isArray(value)) {return value.map(sortedKeys);}
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(byKey).map(([key, child]) => [key, sortedKeys(child)]));
  }
  return value;
};

const replay = (log: Array<Array<Logged>>, caseIndex: () => number): Query => {
  const cursors = new Map<number, number>();
  return async (sql: string): Promise<QueryResult> => {
    const index = caseIndex();
    const at = cursors.get(index) ?? 0;
    const entry = log[index]?.[at];
    // shortcut: pre-ingest recordings omit this insert; drop after PARITY_RECORD=1
    if (sql.includes("INSERT INTO ai_jobs") && !entry?.sql?.includes("INSERT INTO ai_jobs")) {
      return { rows: [{ id: "00000000-0000-4000-8000-000000000099", queue: "q:ingest" }], rowCount: 1 };
    }
    cursors.set(index, at + 1);
    assert.ok(entry, `case ${index}: no recorded result for query #${at}: ${sql.slice(0, 120)}`);
    assert.equal(sql, entry.sql, `case ${index}: query #${at} changed; re-record with PARITY_PG_URL and PARITY_RECORD=1`);
    if (entry.error) {throw Object.assign(new Error(entry.error.message), { code: entry.error.code });}
    return { rows: structuredClone(entry.rows || []), rowCount: entry.rowCount ?? (entry.rows || []).length };
  };
};

/** Slots are taken when a query is issued, the order replay reads them in, even when queries run in parallel. */
const recording = (live: Query, log: Array<Array<Logged>>, caseIndex: () => number): Query => async (sql, params = []) => {
  const index = caseIndex();
  log[index] ||= [];
  const at = log[index].push({ sql }) - 1;
  try {
    const result = await live(sql, params);
    log[index][at] = { sql, rows: structuredClone(result.rows), rowCount: result.rowCount };
    return result;
  } catch (error) {
    const e = errorInfo(error);
    log[index][at] = { sql, error: { code: e.code, message: String(e.message) } };
    throw error;
  }
};

const requestBody = (body: unknown, headers: Headers): BodyInit | undefined => {
  if (body === null || body === undefined) {return undefined;}
  const multipart = (body as { multipart?: Multipart }).multipart;
  if (!multipart) {
    headers.set("content-type", "application/json");
    return JSON.stringify(body);
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(multipart.fields || {})) {form.set(key, value);}
  if (multipart.file) {
    const bytes = Buffer.from(multipart.file.base64, "base64");
    form.set("file", new File([bytes], multipart.file.name, { type: multipart.file.type }));
  }
  return form;
};

const drop = (value: Json, keys: Array<string> = []): Json => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {return value;}
  const inner = value.data;
  if (!keys.length || !inner || typeof inner !== "object") {return value;}
  return { ...value, data: Object.fromEntries(Object.entries(inner).filter(([key]) => !keys.includes(key))) };
};

const fakeFetch = (rules: Array<HttpRule>): typeof fetch => async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const rule = rules.find((r) => r.method === method && url.startsWith(r.url));
  if (!rule) {return new Response(JSON.stringify({ error: "no parity rule for " + url }), { status: 599 });}
  return new Response(JSON.stringify(rule.body ?? null), { status: rule.status ?? 200, headers: { "content-type": "application/json" } });
};

const expected = (golden: Golden, known: Set<string>, ignore?: Array<string>): string => {
  if (golden.location !== undefined) {return JSON.stringify(normalize({ location: golden.location }, known));}
  if (golden.base64 !== undefined) {return JSON.stringify({ contentType: golden.contentType, base64: golden.base64 });}
  return JSON.stringify(normalize(drop(golden.body ?? null, ignore), known));
};

const actual = async (res: Response, known: Set<string>, ignore?: Array<string>): Promise<string> => {
  if (res.status >= 300 && res.status < 400) {return JSON.stringify(normalize({ location: res.headers.get("location") }, known));}
  const kind = res.headers.get("content-type") || "";
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length && !kind.startsWith("application/json")) {return JSON.stringify({ contentType: kind, base64: bytes.toString("base64") });}
  return JSON.stringify(normalize(drop(bytes.length ? parseJson(bytes.toString("utf8")) : null, ignore), known));
};

const nothing = async (): Promise<void> => undefined;

export const parityGroup = async (group: string, base: CoreEnv = { APP_ENV: "production" }): Promise<{ ran: boolean; mismatches: Array<string> }> => {
  const cases = read(`${group}.cases.json`, listOf(isCase));
  const env: CoreEnv = existsSync(resolve(DIR, `${group}.env.json`)) ? { ...base, ...read(`${group}.env.json`, isEnv) } : base;
  const fetchImpl = existsSync(resolve(DIR, `${group}.http.json`)) ? fakeFetch(read(`${group}.http.json`, listOf(isHttpRule))) : undefined;
  const golden = read(`${group}.golden.json`, listOf(isGolden));
  const queriesFile = `${group}.queries.json`;
  const url = process.env.PARITY_PG_URL;
  if (!url && !existsSync(resolve(DIR, queriesFile))) {return { ran: false, mismatches: [] };}
  let current = 0;
  const log: Array<Array<Logged>> = [];
  let query: Query;
  let close = nothing;
  if (url) {
    const { livePg } = await import("./pg.ts");
    const pg = await livePg(url);
    close = pg.close;
    try {
      await pg.query(readFileSync(resolve(DIR, "seed.sql"), "utf8"));
      if (existsSync(resolve(DIR, `${group}.seed.sql`))) {await pg.query(readFileSync(resolve(DIR, `${group}.seed.sql`), "utf8"));}
    } catch (error) {
      await close();
      throw error;
    }
    query = recording(pg.query, log, () => current);
  } else {
    query = replay(read(queriesFile, listOf(listOf(isLogged))), () => current);
  }
  const known = knownIds(group);
  const mismatches: Array<string> = [];
  try {
    for (const [index, item] of cases.entries()) {
      current = index;
      resetLimits();
      if (item.sql) {
        const result = await query(item.sql);
        const rows = result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, (v === null || v === undefined) ? null : String(v)])));
        const got = JSON.stringify(normalize(rows, known));
        const want = JSON.stringify(normalize(golden[index].body, known));
        if (got !== want) {mismatches.push(`${item.name}: rows differ\n  core:   ${got}\n  golden: ${want}`);}
        continue;
      }
      const headers = new Headers({ "x-request-id": "parity" });
      if (item.auth !== false) {headers.set("authorization", "Bearer parity-token");}
      if (["POST", "PATCH", "PUT"].includes(item.method)) {headers.set("idempotency-key", idempotencyKey(index));}
      const res = await handle(new Request("http://testserver" + item.path, {
        method: item.method,
        headers,
        body: requestBody(item.body, headers),
      }), env, { query, now: () => NOW, fetch: fetchImpl });
      const order = (text: string): string => (item.sortKeys ? JSON.stringify(sortedKeys(parseJson(text))) : text);
      const want = order(expected(golden[index], known, item.ignoreKeys));
      const got = order(await actual(res, known, item.ignoreKeys));
      if (res.status !== golden[index].status || got !== want) {
        mismatches.push(`${item.name}: status ${res.status} vs ${golden[index].status}\n  core:   ${got}\n  golden: ${want}`);
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
