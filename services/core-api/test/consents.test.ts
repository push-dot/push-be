import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";

const USER = "12345678-1234-5678-1234-567812345678";
const NOW = "2026-10-21T00:00:00.000Z";
const STORED_AT = "2026-10-21T03:04:05.000Z";
const PATH = "/api/v1/me/consents";

type Call = { sql: string; params: unknown[] };
type Terms = {
  version: string | null;
  age14At: string | null;
  serviceTermsAt: string | null;
  privacyAt: string | null;
  marketing: boolean;
  marketingAt: string | null;
};
type ConsentBody = { data: { referenceData: boolean; updatedAt: string | null; terms: Terms } };
const EMPTY_TERMS: Terms = {
  version: null,
  age14At: null,
  serviceTermsAt: null,
  privacyAt: null,
  marketing: false,
  marketingAt: null,
};
type Err = { error: { code: string; details: { field?: string } | null } };

const env = (): CoreEnv => ({ APP_ENV: "production" });

const deps = (query: Deps["query"]): Deps => ({ query, now: () => new Date(NOW) });

const tokenRow = () => ({
  id: USER,
  display_name: "Ada",
  locale: "ko",
  plan: "FREE",
  subscription_status: "NONE",
  created_at: NOW,
  token_expires_at: "2099-01-01T00:00:00Z",
  is_employer: false,
});

const authed = (seen: Call[], extra: Deps["query"]): Deps["query"] => async (sql, params = []) => {
  seen.push({ sql, params });
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("access_tokens")) return { rows: [tokenRow()], rowCount: 1 };
  return extra(sql, params);
};

const empty = { rows: [] as Record<string, unknown>[], rowCount: 0 };

const get = (): Request => new Request("https://core.example" + PATH, {
  headers: { authorization: "Bearer secret-token" },
});

const put = (body: unknown): Request => new Request("https://core.example" + PATH, {
  method: "PUT",
  headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const read = async (res: Response): Promise<ConsentBody> => JSON.parse(await res.text()) as ConsentBody;

const consentSql = (seen: Call[], verb: string): Call[] =>
  seen.filter((call) => call.sql.includes("user_consents") || call.sql.includes("reference_samples"))
    .filter((call) => call.sql.includes(verb));

test("missing consent row is false and does not insert", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get(), env(), deps(authed(seen, async () => empty)));
  assert.equal(res.status, 200);
  const body = await read(res);
  assert.deepEqual(Object.keys(body.data), ["referenceData", "updatedAt", "terms"]);
  assert.deepEqual(body.data, { referenceData: false, updatedAt: null, terms: EMPTY_TERMS });
  const select = seen.find((call) => call.sql.startsWith("SELECT reference_data"));
  assert.deepEqual(select?.params, [USER]);
  assert.equal(consentSql(seen, "INSERT").length, 0);
  assert.equal(consentSql(seen, "DELETE").length, 0);
});

test("existing consent returns the stored choice", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(get(), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("user_consents")) {
      return { rows: [{ reference_data: true, updated_at: STORED_AT }], rowCount: 1 };
    }
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await read(res);
  assert.deepEqual(body.data, { referenceData: true, updatedAt: "2026-10-21T03:04:05Z", terms: EMPTY_TERMS });
  assert.equal(consentSql(seen, "INSERT").length, 0);
});

test("turning reference data on upserts and keeps samples", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(put({ referenceData: true }), env(), deps(authed(seen, async () => empty)));
  assert.equal(res.status, 200);
  const body = await read(res);
  assert.deepEqual(Object.keys(body.data), ["referenceData", "updatedAt", "terms"]);
  assert.deepEqual(body.data, { referenceData: true, updatedAt: "2026-10-21T00:00:00Z", terms: EMPTY_TERMS });
  const upsert = seen.find((call) => call.sql.includes("INSERT INTO user_consents"));
  assert.equal(upsert?.sql.includes("ON CONFLICT (user_id)"), true);
  assert.deepEqual(upsert?.params, [USER, true, NOW]);
  assert.equal(seen.some((call) => call.sql.includes("reference_samples")), false);
});

test("turning reference data off deletes samples and stores false", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(put({ referenceData: false }), env(), deps(authed(seen, async () => empty)));
  assert.equal(res.status, 200);
  const body = await read(res);
  assert.deepEqual(body.data, { referenceData: false, updatedAt: "2026-10-21T00:00:00Z", terms: EMPTY_TERMS });
  const deleted = seen.find((call) => call.sql.includes("reference_samples"));
  assert.equal(deleted?.sql, "DELETE FROM reference_samples WHERE source_user_id = $1");
  assert.deepEqual(deleted?.params, [USER]);
  const upsert = seen.find((call) => call.sql.includes("INSERT INTO user_consents"));
  assert.deepEqual(upsert?.params, [USER, false, NOW]);
  const deleteAt = seen.findIndex((call) => call.sql.includes("reference_samples"));
  const upsertAt = seen.findIndex((call) => call.sql.includes("INSERT INTO user_consents"));
  assert.equal(upsertAt < deleteAt, true);
});

test("a non-boolean referenceData is a validation error", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(put({ referenceData: "true" }), env(), deps(authed(seen, async () => empty)));
  assert.equal(res.status, 400);
  const body = JSON.parse(await res.text()) as Err;
  assert.equal(body.error.code, "VALIDATION_ERROR");
  assert.equal(body.error.details?.field, "referenceData");
  assert.equal(consentSql(seen, "INSERT").length, 0);
  assert.equal(consentSql(seen, "DELETE").length, 0);
});

const termsPut = (body: unknown): Request => new Request("https://core.example" + PATH + "/terms", {
  method: "PUT",
  headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const agreedRow = (version: string, marketing: boolean) => ({
  reference_data: false,
  updated_at: NOW,
  terms_version: version,
  age14_at: NOW,
  service_terms_at: NOW,
  privacy_at: NOW,
  marketing,
  marketing_at: NOW,
});

test("signup terms store the version and marketing, and the default version is used", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(termsPut({
    age14: true, serviceTerms: true, privacy: true, marketing: true, termsVersion: "v9",
  }), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("INSERT INTO user_consents")) return empty;
    if (sql.includes("FROM user_consents")) return { rows: [agreedRow("v9", true)], rowCount: 1 };
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await read(res);
  assert.equal(body.data.referenceData, false);
  assert.equal(body.data.terms.version, "v9");
  assert.equal(body.data.terms.marketing, true);
  assert.equal(body.data.terms.age14At, "2026-10-21T00:00:00Z");
  const upsert = seen.find((call) => call.sql.includes("INSERT INTO user_consents"));
  assert.match(upsert?.sql ?? "", /COALESCE\(user_consents\.terms_version/);
  assert.deepEqual(upsert?.params, [USER, NOW, true, "v9", true, true]);

  resetLimits();
  const again: Call[] = [];
  const omitted = await handle(termsPut({ age14: true, serviceTerms: true, privacy: true }), env(), deps(authed(again, async () => empty)));
  assert.equal(omitted.status, 200);
  const fallback = again.find((call) => call.sql.includes("INSERT INTO user_consents"));
  assert.deepEqual(fallback?.params, [USER, NOW, true, "2026-10-29", false, false]);
});

test("required terms cannot be turned off or agreed one at a time", async () => {
  resetLimits();
  const seen: Call[] = [];
  const off = await handle(termsPut({ age14: false, serviceTerms: true, privacy: true }), env(), deps(authed(seen, async () => empty)));
  assert.equal(off.status, 400);
  assert.equal((JSON.parse(await off.text()) as Err).error.details?.field, "age14");
  const partial = await handle(termsPut({ age14: true }), env(), deps(authed(seen, async () => empty)));
  assert.equal(partial.status, 400);
  assert.equal((JSON.parse(await partial.text()) as Err).error.details?.field, "serviceTerms");
  const none = await handle(termsPut({}), env(), deps(authed(seen, async () => empty)));
  assert.equal(none.status, 400);
  assert.equal(consentSql(seen, "INSERT").length, 0);
});

test("marketing can change without restating the required terms", async () => {
  resetLimits();
  const seen: Call[] = [];
  const res = await handle(termsPut({ marketing: false }), env(), deps(authed(seen, async (sql) => {
    if (sql.includes("INSERT INTO user_consents")) return empty;
    if (sql.includes("FROM user_consents")) {
      return { rows: [{ reference_data: true, updated_at: STORED_AT, marketing: false }], rowCount: 1 };
    }
    return empty;
  })));
  assert.equal(res.status, 200);
  const body = await read(res);
  assert.equal(body.data.referenceData, true);
  assert.equal(body.data.terms.marketing, false);
  assert.equal(body.data.terms.version, null);
  const upsert = seen.find((call) => call.sql.includes("INSERT INTO user_consents"));
  assert.deepEqual(upsert?.params, [USER, NOW, false, null, true, false]);
});
