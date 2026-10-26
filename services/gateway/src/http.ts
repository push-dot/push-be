/**
 * HTTP helpers shared by the gateway routes. Response bytes match the
 * previous single-module handler.
 */

import { pyJson } from "./time.ts";
import { weakEtag } from "./middleware/cache.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const ALLOWED_ORIGINS = new Set([
  "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost",
]);
const ALLOWED_HEADERS = new Set([
  "origin", "content-type", "accept", "authorization",
  "idempotency-key", "x-request-id",
]);

export const USER_CACHE_CONTROL = "private, no-cache";

export function asBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

export function flag(value: string | undefined): boolean {
  const v = (value || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "";
}

export function corsHeaders(request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get("origin") || "";
  if (origin && (ALLOWED_ORIGINS.has(origin) || ORIGIN_RE.test(origin))) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
  }
  // The allow-origin header depends on Origin, so a cache must key on it either way.
  headers.set("vary", "Origin");
  return headers;
}

export function withCors(request: Request, response: Response): Response {
  try {
    const headers = new Headers(response.headers);
    for (const [k, v] of corsHeaders(request)) {
      if (k.toLowerCase() === "vary") {
        const existing = headers.get("vary");
        if (!existing) headers.set("vary", v);
        else if (!existing.split(",").some((name) => name.trim().toLowerCase() === v.toLowerCase())) {
          headers.set("vary", `${existing}, ${v}`);
        }
      } else if (!headers.has(k)) {
        headers.set(k, v);
      }
    }
    // 204/205/304 reject a body. Copying response.body threw and the
    // Worker recorded an exception instead of returning the response.
    if (response.status === 204 || response.status === 205 || response.status === 304) {
      headers.delete("content-length");
      return new Response(null, { status: response.status, headers });
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

export function requestIdOf(request: Request): string {
  // Forwarded to core and python logs and echoed back, so only a plain token is kept.
  const rid = request.headers.get("x-request-id") || "";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(rid) ? rid : "req_" + crypto.randomUUID();
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

export function errorResponse(status: number, code: string, message: string, rid: string, details: unknown = null): Response {
  return jsonResponse(status, {
    error: { code, message, requestId: rid, details },
  }, rid, "application/json; charset=utf-8");
}

export function fieldError(field: string, message: string, rid: string): Response {
  return errorResponse(400, "VALIDATION_ERROR", message, rid, { field });
}

export function conditional(body: string, request: Request, rid: string, cacheControl: string): Response {
  const etag = weakEtag(body);
  const headers = new Headers({
    etag,
    "cache-control": cacheControl,
    vary: "Authorization",
    "x-request-id": rid,
  });
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("content-type", "application/json");
  headers.set("content-length", String(new TextEncoder().encode(body).byteLength));
  return new Response(body, { status: 200, headers });
}

export async function freshRead(loaded: Response, request: Request, rid: string): Promise<Response> {
  if (loaded.status !== 200) return loaded;
  return conditional(await loaded.text(), request, rid, USER_CACHE_CONTROL);
}

export async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares digests, so the time taken does not depend on where the inputs differ. Empty never matches. */
export async function secretEquals(got: string, want: string): Promise<boolean> {
  if (!got || !want) return false;
  return (await sha256Hex(got)) === (await sha256Hex(want));
}

export function parseUuid(value: string): string | null {
  if (UUID_RE.test(value)) return value.toLowerCase();
  if (/^[0-9a-f]{32}$/i.test(value)) {
    const h = value.toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return null;
}

export function pageLimit(url: URL, rid: string): { limit: number } | Response {
  const raw = url.searchParams.get("limit");
  if (!raw) return { limit: 50 };
  if (!/^[1-9]\d*$/.test(raw)) return fieldError("limit", "must be a positive integer", rid);
  return { limit: Math.min(Number(raw), 100) };
}
export function preflight(request: Request): Response {
  const headers = corsHeaders(request);
  const requested = (request.headers.get("access-control-request-headers") || "")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const allowHeaders = requested.filter((h) => ALLOWED_HEADERS.has(h));
  headers.set("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", allowHeaders.join(", ") || "Authorization, Content-Type");
  headers.set("access-control-max-age", "600");
  const body = "OK";
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("content-length", String(body.length));
  return new Response(body, { status: 200, headers });
}
export function jsonRows(value: unknown): Record<string, unknown>[] {
  let raw = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => item && typeof item === "object") as Record<string, unknown>[];
}
export function codedError(err: unknown, rid: string): Response {
  const coded = err as { status?: number; code?: string; message?: string };
  if (coded.status && coded.code) {
    return errorResponse(coded.status, coded.code, coded.message || "internal error", rid);
  }
  return errorResponse(500, "INTERNAL", "internal error", rid);
}
