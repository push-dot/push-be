import type { StoreReceipts } from "./billing/stores.ts";
import type { Query } from "./db.ts";
import type { Mailer } from "./mail/mailer.ts";

export interface Fetcher {
  fetch(input: Request): Promise<Response>;
}

export interface CoreEnv {
  DATABASE_URL?: string;
  API?: Fetcher;
  /** When set, the VPS worker consumes chat_jobs and core skips the Workflow. */
  AI_ORIGIN?: string;
  /** postgres keeps the chat_jobs insert. redis uses enqueueJob. */
  QUEUE_BACKEND?: string;
  DISPATCH_ORIGIN?: string;
  DISPATCH_SECRET?: string;
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
  GOOGLE_GMAIL_BETA_ENABLED?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_ULTRA?: string;
  STRIPE_PRICE_EMPLOYER_BASIC?: string;
  STRIPE_PRICE_EMPLOYER_PRO?: string;
  STRIPE_PRICE_EMPLOYER_ULTRA?: string;
  STRIPE_PRICE_TOPUP?: string;
  STRIPE_SUCCESS_URL?: string;
  STRIPE_CANCEL_URL?: string;
  STRIPE_PORTAL_RETURN_URL?: string;
  MAIL_FROM?: string;
  RESEND_API_KEY?: string;
  EXPO_ACCESS_TOKEN?: string;
  INTERNAL_JOB_TOKEN?: string;
  INTERNAL_API_SECRET?: string;
  APP_WEB_ORIGIN?: string;
  OAUTH_REDIRECT_ORIGINS?: string;
  NTS_SERVICE_KEY?: string;
  IAP_PRODUCT_PRO?: string;
  IAP_PRODUCT_ULTRA?: string;
  IAP_PRODUCT_TOPUP?: string;
  IAP_TOPUP_CREDITS?: string;
  APPLE_BUNDLE_ID?: string;
  APPLE_ROOT_PEM?: string;
  GOOGLE_PLAY_KEY?: string;
  GOOGLE_PLAY_PACKAGE?: string;
  GOOGLE_OIDC_AUDIENCE?: string;
  GOOGLE_OIDC_KEY?: string;
  EMAIL?: {
    send(message: { to: string; from: string; subject: string; text: string; html: string }): Promise<unknown>;
  };
}

export interface Deps {
  query: Query;
  now?: () => Date;
  fetch?: typeof fetch;
  mailer?: Mailer;
  stores?: StoreReceipts;
}

export interface UserRow {
  id: string;
  displayName: string;
  locale: string;
  email: string;
  provider: string;
  plan: string;
  subscriptionStatus: string;
  stripeCustomerId: string | null;
  periodEndsAt: string | null;
  createdAt: string;
  accountType: "PERSONAL" | "EMPLOYER";
  companyId: string | null;
  companyRole: string | null;
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
