import { one, query } from "../db.ts";
import { HttpError, asBool, data, fieldError } from "../http.ts";
import { ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import { readObject } from "./recruiting-shared.ts";

const PATH = "/api/v1/me/consents";
const TERMS_PATH = "/api/v1/me/consents/terms";
export const TERMS_VERSION = "1.0";
const REQUIRED = ["age14", "serviceTerms", "privacy"] as const;
const SELECT = "SELECT reference_data, updated_at, terms_version, age14_at, service_terms_at, privacy_at, marketing, marketing_at FROM user_consents WHERE user_id = $1";
// Every parameter is cast: $2 is both a VALUES column and a CASE branch, and without
// casts Postgres reports "inconsistent types deduced for parameter $2".
const TERMS_UPSERT = "INSERT INTO user_consents (user_id, reference_data, updated_at, terms_version, age14_at, service_terms_at, privacy_at, marketing, marketing_at) "
  + "VALUES ($1, false, $2::timestamptz, CASE WHEN $3::boolean THEN $4::text ELSE NULL END, CASE WHEN $3::boolean THEN $2::timestamptz ELSE NULL END, CASE WHEN $3::boolean THEN $2::timestamptz ELSE NULL END, CASE WHEN $3::boolean THEN $2::timestamptz ELSE NULL END, CASE WHEN $5::boolean THEN $6::boolean ELSE false END, CASE WHEN $5::boolean THEN $2::timestamptz ELSE NULL END) "
  + "ON CONFLICT (user_id) DO UPDATE SET terms_version = COALESCE(user_consents.terms_version, EXCLUDED.terms_version), "
  + "age14_at = COALESCE(user_consents.age14_at, EXCLUDED.age14_at), "
  + "service_terms_at = COALESCE(user_consents.service_terms_at, EXCLUDED.service_terms_at), "
  + "privacy_at = COALESCE(user_consents.privacy_at, EXCLUDED.privacy_at), "
  + "marketing = CASE WHEN $5::boolean THEN $6::boolean ELSE user_consents.marketing END, "
  + "marketing_at = CASE WHEN $5::boolean THEN $2::timestamptz ELSE user_consents.marketing_at END";
// A different terms_version is a new agreement. The previous row is the proof, so it is copied
// before the live row is overwritten. The same version stays on TERMS_UPSERT (COALESCE).
const REPLACE_TERMS = "WITH previous AS ("
  + "SELECT user_id, terms_version, age14_at, service_terms_at, privacy_at FROM user_consents "
  + "WHERE user_id = $1::uuid AND terms_version IS NOT NULL AND terms_version IS DISTINCT FROM $3::text), "
  + "archived AS ("
  + "INSERT INTO user_consent_history (id, user_id, terms_version, age14_at, service_terms_at, privacy_at, replaced_at) "
  + "SELECT $6::uuid, user_id, terms_version, age14_at, service_terms_at, privacy_at, $2::timestamptz FROM previous "
  + "RETURNING user_id) "
  + "UPDATE user_consents SET terms_version = $3::text, age14_at = $2::timestamptz, "
  + "service_terms_at = $2::timestamptz, privacy_at = $2::timestamptz, "
  + "marketing = CASE WHEN $4::boolean THEN $5::boolean ELSE user_consents.marketing END, "
  + "marketing_at = CASE WHEN $4::boolean THEN $2::timestamptz ELSE user_consents.marketing_at END "
  + "WHERE user_id = $1::uuid AND user_id IN (SELECT user_id FROM archived)";

const termsOf = (row: Record<string, unknown> | null) => ({
  version: row?.terms_version == null ? null : String(row.terms_version),
  age14At: ts(row?.age14_at),
  serviceTermsAt: ts(row?.service_terms_at),
  privacyAt: ts(row?.privacy_at),
  marketing: asBool(row?.marketing),
  marketingAt: ts(row?.marketing_at),
});

const view = (referenceData: boolean, updatedAt: string | null, row: Record<string, unknown> | null) => ({
  referenceData,
  updatedAt,
  terms: termsOf(row),
});

const load = async (ctx: Ctx): Promise<Record<string, unknown> | null> =>
  one(ctx.deps.query, SELECT, [ctx.user.id]);

const getConsents = async (ctx: Ctx): Promise<Response> => {
  const row = await load(ctx);
  if (!row) return data(200, view(false, null, null), ctx.rid);
  return data(200, view(asBool(row.reference_data), ts(row.updated_at), row), ctx.rid);
};

const putConsents = async (ctx: Ctx): Promise<Response> => {
  const body = await readObject(ctx.request);
  if (typeof body.referenceData !== "boolean") throw fieldError("referenceData", "must be a boolean");
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    "INSERT INTO user_consents (user_id, reference_data, updated_at) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET reference_data = EXCLUDED.reference_data, updated_at = EXCLUDED.updated_at",
    [ctx.user.id, body.referenceData, now]);
  if (!body.referenceData) {
    await query(ctx.deps.query, "DELETE FROM reference_samples WHERE source_user_id = $1", [ctx.user.id]);
  }
  return data(200, view(body.referenceData, ts(now), await load(ctx)), ctx.rid);
};

const putTerms = async (ctx: Ctx): Promise<Response> => {
  const body = await readObject(ctx.request);
  const allowed = new Set(["age14", "serviceTerms", "privacy", "marketing", "termsVersion"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
  const sent = REQUIRED.filter((key) => key in body);
  if (sent.length > 0 && sent.length !== REQUIRED.length) {
    const missing = REQUIRED.find((key) => !(key in body)) ?? sent[0];
    throw fieldError(missing, "must be true");
  }
  for (const key of sent) {
    if (body[key] !== true) throw fieldError(key, "cannot be turned off");
  }
  const agree = sent.length === REQUIRED.length;
  let version: string | null = null;
  if ("termsVersion" in body) {
    if (!agree) throw fieldError("termsVersion", "send it with the required terms");
    if (typeof body.termsVersion !== "string" || body.termsVersion.length < 1 || body.termsVersion.length > 64) {
      throw fieldError("termsVersion", "must be 1-64 characters");
    }
    version = body.termsVersion;
  } else if (agree) {
    version = TERMS_VERSION;
  }
  const marketingSet = "marketing" in body;
  if (marketingSet && typeof body.marketing !== "boolean") throw fieldError("marketing", "must be a boolean");
  if (!agree && !marketingSet) throw new HttpError(400, "VALIDATION_ERROR", "request body required");
  const now = ctx.now.toISOString();
  const marketing = marketingSet ? body.marketing : false;
  let replaced = false;
  if (agree && version != null) {
    const existing = await load(ctx);
    const stored = existing?.terms_version == null ? null : String(existing.terms_version);
    if (stored != null && stored !== version) {
      await query(ctx.deps.query, REPLACE_TERMS, [ctx.user.id, now, version, marketingSet, marketing, crypto.randomUUID()]);
      replaced = true;
    }
  }
  if (!replaced) {
    await query(ctx.deps.query, TERMS_UPSERT, [ctx.user.id, now, agree, version, marketingSet, marketing]);
  }
  return getConsents(ctx);
};

export const dispatchConsents = async (ctx: Ctx, path: string): Promise<Response | null> => {
  if (path === TERMS_PATH) {
    if (ctx.request.method === "PUT") return putTerms(ctx);
    return null;
  }
  if (path !== PATH) return null;
  if (ctx.request.method === "GET") return getConsents(ctx);
  if (ctx.request.method === "PUT") return putConsents(ctx);
  return null;
};
