// Terms version changes on a real Postgres (BILLING_PG_URL, a migrated schema; CI test-db sets it).
// A mock cannot apply user_consents_terms_chk or the history insert.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Query } from "../src/db.ts";
import { handle, type CoreEnv } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { livePg, type LivePg } from "./parity/pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const env: CoreEnv = { APP_ENV: "production" };
const NOW = "2026-11-10T00:00:00.000Z";
const EARLIER = "2026-10-21T03:04:05.000Z";

let pg: LivePg | undefined;
before(async () => { if (URL_) pg = await livePg(URL_); });
after(async () => { await pg?.close(); });

const dbFor = (userId: string): Query => async (sql, params = []) => {
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("access_tokens")) {
    return {
      rows: [{
        id: userId, display_name: "민아", locale: "ko", plan: "FREE", subscription_status: "NONE",
        stripe_customer_id: null, period_ends_at: null, created_at: EARLIER, token_expires_at: "2099-01-01T00:00:00Z",
        is_employer: true, company_id: null, company_role: null, email: "mina@push.app", provider: "email",
      }],
      rowCount: 1,
    };
  }
  return pg!.query(sql, params);
};

const putTerms = async (userId: string, body: unknown) => {
  resetLimits();
  const res = await handle(new Request("https://core.example/api/v1/me/consents/terms", {
    method: "PUT",
    headers: { authorization: "Bearer consent-test", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env, { query: dbFor(userId), now: () => new Date(NOW) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as { data: { terms: { version: string | null; age14At: string | null; marketing: boolean } } } : null };
};

const agree = (termsVersion: string) => ({ age14: true, serviceTerms: true, privacy: true, termsVersion });

test("the same terms version keeps the timestamps and a new version keeps one history row", async (t) => {
  if (!pg) return t.skip("set BILLING_PG_URL to a migrated Postgres");
  const user = crypto.randomUUID();
  await pg.query(
    "INSERT INTO users (id, provider, provider_subject, display_name, plan, created_at) VALUES ($1::uuid, 'test', $1::uuid::text, 'consent fixture', 'FREE', $2::timestamptz)",
    [user, EARLIER],
  );
  await pg.query(
    `INSERT INTO user_consents (user_id, reference_data, updated_at, terms_version, age14_at, service_terms_at, privacy_at, marketing, marketing_at)
     VALUES ($1::uuid, false, $2::timestamptz, '1.0', $2::timestamptz, $2::timestamptz, $2::timestamptz, true, $2::timestamptz)`,
    [user, EARLIER],
  );

  const same = await putTerms(user, agree("1.0"));
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body?.data.terms.version, "1.0");
  assert.equal(same.body?.data.terms.age14At, "2026-10-21T03:04:05Z");
  assert.equal(same.body?.data.terms.marketing, true);
  const untouched = await pg.query("SELECT count(*)::int AS n FROM user_consent_history WHERE user_id = $1::uuid", [user]);
  assert.equal(untouched.rows[0].n, 0);

  const next = await putTerms(user, agree("2.0"));
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(next.body?.data.terms.version, "2.0");
  assert.equal(next.body?.data.terms.age14At, "2026-11-10T00:00:00Z");
  assert.equal(next.body?.data.terms.marketing, true);
  const history = await pg.query(
    "SELECT terms_version, age14_at, service_terms_at, privacy_at FROM user_consent_history WHERE user_id = $1::uuid",
    [user],
  );
  assert.equal(history.rows.length, 1);
  assert.equal(history.rows[0].terms_version, "1.0");
  assert.equal(new Date(String(history.rows[0].age14_at)).toISOString(), new Date(EARLIER).toISOString());
  assert.equal(String(history.rows[0].age14_at), String(history.rows[0].service_terms_at));
  assert.equal(String(history.rows[0].age14_at), String(history.rows[0].privacy_at));

  const again = await putTerms(user, agree("2.0"));
  assert.equal(again.status, 200);
  assert.equal(again.body?.data.terms.age14At, "2026-11-10T00:00:00Z");
  const stillOne = await pg.query("SELECT count(*)::int AS n FROM user_consent_history WHERE user_id = $1::uuid", [user]);
  assert.equal(stillOne.rows[0].n, 1);

  await pg.query("DELETE FROM users WHERE id = $1::uuid", [user]);
  const gone = await pg.query("SELECT count(*)::int AS n FROM user_consent_history WHERE user_id = $1::uuid", [user]);
  assert.equal(gone.rows[0].n, 0);
});

test("a stored placeholder version is archived when the user agrees to 1.0", async (t) => {
  if (!pg) return t.skip("set BILLING_PG_URL to a migrated Postgres");
  const user = crypto.randomUUID();
  await pg.query(
    "INSERT INTO users (id, provider, provider_subject, display_name, plan, created_at) VALUES ($1::uuid, 'test', $1::uuid::text, 'legacy fixture', 'FREE', $2::timestamptz)",
    [user, EARLIER],
  );
  await pg.query(
    `INSERT INTO user_consents (user_id, reference_data, updated_at, terms_version, age14_at, service_terms_at, privacy_at)
     VALUES ($1::uuid, false, $2::timestamptz, '2026-10-29', $2::timestamptz, $2::timestamptz, $2::timestamptz)`,
    [user, EARLIER],
  );
  const res = await putTerms(user, agree("1.0"));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body?.data.terms.version, "1.0");
  assert.equal(res.body?.data.terms.age14At, "2026-11-10T00:00:00Z");
  const history = await pg.query(
    "SELECT terms_version FROM user_consent_history WHERE user_id = $1::uuid",
    [user],
  );
  assert.deepEqual(history.rows.map((row) => row.terms_version), ["2026-10-29"]);
  await pg.query("DELETE FROM users WHERE id = $1::uuid", [user]);
});
