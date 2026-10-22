/**
 * Shared gateway types. Route modules and middleware import these so the
 * worker entry, the rate limiter, and the handlers do not depend on each other.
 */

export interface CacheStore {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
  delete(req: Request): Promise<boolean>;
}

export interface Query {
  (text: string, params: unknown[]): Promise<Record<string, unknown>[]>;
}

export interface FrontEnv {
  DATABASE_URL?: string;
  API: { fetch(input: Request): Promise<Response> };
  CORE?: { fetch(input: Request): Promise<Response> };
  APP_ENV?: string;
  DEV_AUTH_TOKEN?: string;
  DEV_USER_ID?: string;
  MANAGED_AI?: string;
  MANAGED_GO?: string;
  SSE_MAX_POLLS?: string;
  MODEL_CACHE_TTL?: string;
  JOB_SITES_CACHE_TTL?: string;
  AUTH_CACHE_TTL?: string;
  /** HTTPS origin of the AI service on the VPS. Unset keeps the API service binding. */
  AI_ORIGIN?: string;
  /** Shared secret sent as x-push-ai-secret when AI_ORIGIN is set. */
  AI_SHARED_SECRET?: string;
  /** AI worker act-as secret (same value as core). Requests that carry it keep their act-as headers to core. */
  INTERNAL_API_SECRET?: string;
}

export interface Deps {
  query: Query;
  cache?: CacheStore;
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
