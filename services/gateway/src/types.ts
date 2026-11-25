/**
 * Shared gateway types. Route modules and middleware import these so the
 * worker entry, the rate limiter, and the handlers do not depend on each other.
 */

/** A value JSON.parse returns and a json/jsonb column decodes to. */
export type Json = string | number | boolean | null | Array<Json> | JsonObject;

export interface JsonObject {
  [key: string]: Json;
}

/** A column value as the Neon driver decodes it. */
export type DbValue = Json | Date | Uint8Array;

export type Row = Record<string, DbValue>;

export interface Query {
  (text: string, params: Array<unknown>): Promise<Array<Row>>;
}

export interface FrontEnv {
  DATABASE_URL?: string;
  CORE?: { fetch(input: Request): Promise<Response> };
  APP_ENV?: string;
  DEV_AUTH_TOKEN?: string;
  DEV_USER_ID?: string;
  MANAGED_AI?: string;
  SSE_MAX_POLLS?: string;
  MODEL_CACHE_TTL?: string;
  JOB_SITES_CACHE_TTL?: string;
  AUTH_CACHE_TTL?: string;
  /** HTTPS origin of push-bot on the VPS. AI routes return 500 when this is empty. */
  AI_ORIGIN?: string;
  /** HTTPS origin of push-agent on the VPS. A company conversation's AI routes go here; empty sends them to AI_ORIGIN. */
  AGENT_ORIGIN?: string;
  /** Shared secret sent as x-push-ai-secret to AI_ORIGIN and AGENT_ORIGIN. */
  AI_SHARED_SECRET?: string;
  /** AI worker act-as secret (same value as core). Requests that carry it keep their act-as headers to core. */
  INTERNAL_API_SECRET?: string;
}

export interface Deps {
  query: Query;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  limits?: { user: number; public: number; windowMs: number };
  waitUntil?: (promise: Promise<unknown>) => void;
  fetch?: typeof fetch;
}

export interface User {
  id: string;
  displayName: string;
  locale: string;
  createdAt: string;
  accountType: "PERSONAL" | "EMPLOYER";
  companyId: string | null;
  companyRole: string | null;
  email: string;
  provider: string;
  plan: string;
}
