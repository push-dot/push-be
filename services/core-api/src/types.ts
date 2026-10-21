import type { Query } from "./db.ts";

export interface Fetcher {
  fetch(input: Request): Promise<Response>;
}

export interface CoreEnv {
  DATABASE_URL?: string;
  API?: Fetcher;
  /** When set, the VPS worker consumes chat_jobs and core skips the Workflow. */
  AI_ORIGIN?: string;
  /** Same value as the VPS AI_SHARED_SECRET. Sent on the wake request. */
  AI_SHARED_SECRET?: string;
  APP_ENV?: string;
  DEV_AUTH_TOKEN?: string;
  DEV_USER_ID?: string;
  MANAGED_AI?: string;
  MANAGED_GO?: string;
  BYOK_MASTER_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_ULTRA?: string;
  STRIPE_SUCCESS_URL?: string;
  STRIPE_CANCEL_URL?: string;
  STRIPE_PORTAL_RETURN_URL?: string;
}

export interface Deps {
  query: Query;
  now?: () => Date;
  fetch?: typeof fetch;
}

export interface UserRow {
  id: string;
  displayName: string;
  locale: string;
  plan: string;
  subscriptionStatus: string;
  stripeCustomerId: string | null;
  periodEndsAt: string | null;
  createdAt: string;
}

export interface Ctx {
  request: Request;
  env: CoreEnv;
  deps: Deps;
  rid: string;
  url: URL;
  user: UserRow;
  now: Date;
}
