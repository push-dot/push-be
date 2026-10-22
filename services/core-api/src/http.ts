import { pyJson } from "./time.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HttpError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function requestIdOf(request: Request): string {
  const rid = request.headers.get("x-request-id") || "";
  if (!rid || rid.length > 128) return "req_" + crypto.randomUUID();
  return rid;
}

export function jsonResponse(status: number, body: unknown, rid: string, contentType = "application/json"): Response {
  const text = pyJson(body);
  return new Response(text, {
    status,
    headers: {
      "content-type": contentType,
      "content-length": String(new TextEncoder().encode(text).byteLength),
      "x-request-id": rid,
    },
  });
}

export function data(status: number, value: unknown, rid: string): Response {
  return jsonResponse(status, { data: value }, rid);
}

export function pageBody(
  items: unknown[],
  nextCursor: string | null,
  hasMore: boolean,
  rid: string,
  total?: number,
): Response {
  const page: Record<string, unknown> = { nextCursor, hasMore };
  if (total !== undefined) page.total = total;
  return jsonResponse(200, { data: items, page }, rid);
}

export function noContent(rid: string): Response {
  return new Response(null, { status: 204, headers: { "x-request-id": rid } });
}

export function errorResponse(status: number, code: string, message: string, rid: string, details: unknown = null): Response {
  return jsonResponse(status, {
    error: { code, message, requestId: rid, details },
  }, rid, "application/json; charset=utf-8");
}

export function errorOf(err: HttpError, rid: string): Response {
  const res = errorResponse(err.status, err.code, err.message, rid, err.details);
  const details = err.details as { retryAfterSec?: number } | null;
  if (err.status === 429 && details && typeof details.retryAfterSec === "number") {
    res.headers.set("retry-after", String(details.retryAfterSec));
  }
  return res;
}

export function fieldError(field: string, message: string): HttpError {
  return new HttpError(400, "VALIDATION_ERROR", message, { field });
}

export function parseUuid(value: string): string | null {
  if (UUID_RE.test(value)) return value.toLowerCase();
  if (/^[0-9a-f]{32}$/i.test(value)) {
    const h = value.toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return null;
}

export function requireUuid(value: string, field: string): string {
  const id = parseUuid(value);
  if (!id) throw fieldError(field, "must be a UUID");
  return id;
}

export function asBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

export function asString(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

export function jsonList(value: unknown): unknown[] {
  let raw = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  return Array.isArray(raw) ? raw : [];
}

export function codePoints(value: string): number {
  return Array.from(value).length;
}

export async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const sortDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((key) => [key, sortDeep(obj[key])]));
  }
  return value;
};

/** Python `hash_json`: sha256 of `json.dumps(v, sort_keys=True, separators=(",", ":"))` (ASCII escapes). */
export async function hashJson(value: unknown): Promise<string> {
  const text = JSON.stringify(sortDeep(value)).replace(/[\u0080-\uffff]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
  return sha256Hex(text);
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "";
}

const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

function uuidBytes(id: string): Uint8Array {
  const hex = id.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** uuid5(NAMESPACE_URL, name), matching Python `uuid.uuid5`. */
export async function uuid5Url(name: string): Promise<string> {
  const ns = uuidBytes(NAMESPACE_URL);
  const tail = new TextEncoder().encode(name);
  const data = new Uint8Array(ns.length + tail.length);
  data.set(ns);
  data.set(tail, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", data)).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return formatUuid(hash);
}
