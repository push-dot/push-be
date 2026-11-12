// Employer email signup on a real Postgres (BILLING_PG_URL, a migrated schema; CI test-db sets it).
// A mock DB cannot see user_consents_terms_chk: only the four consent columns together or none.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { handle, type CoreEnv } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { TERMS_VERSION } from "../src/routes/consents.ts";
import { livePg, type LivePg } from "./parity/pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const env: CoreEnv = { APP_ENV: "production", MANAGED_AI: "1", PENDING_SIGNUP_SECRET: "pending-test-secret" };

let pg: LivePg | undefined;
before(async () => { if (URL_) pg = await livePg(URL_); });
after(async () => { await pg?.close(); });

const post = (path: string, body: unknown) => new Request("https://core.example" + path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("employer email signup verifies and records age14, terms and privacy together", async (t) => {
  if (!pg) return t.skip("set BILLING_PG_URL to a migrated Postgres");
  resetLimits();
  const email = `consent-${crypto.randomUUID().slice(0, 8)}@push.app`;
  const sent: string[] = [];
  const deps = { query: pg.query, now: () => new Date(), mailer: { send: async (mail: { text: string }) => { sent.push(mail.text); } } };

  const signup = await handle(post("/api/v1/auth/email/signup", {
    email, password: "correct-horse-battery-9", accountType: "EMPLOYER", displayName: "Ada", agreeTerms: true,
  }), env, deps);
  assert.equal(signup.status, 202);
  const token = new URL(sent[0].match(/https?:\/\/\S+/)?.[0] ?? "").searchParams.get("token");
  assert.ok(token);

  const verify = await handle(post("/api/v1/auth/email/verify", { token }), env, deps);
  assert.equal(verify.status, 200, await verify.clone().text());

  const { rows } = await pg.query(
    "SELECT c.terms_version, c.age14_at, c.service_terms_at, c.privacy_at FROM user_consents c JOIN users u ON u.id = c.user_id WHERE u.email = $1",
    [email]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].terms_version, TERMS_VERSION);
  assert.ok(rows[0].age14_at && rows[0].service_terms_at && rows[0].privacy_at);
  assert.equal(rows[0].age14_at, rows[0].service_terms_at);
  assert.equal(rows[0].age14_at, rows[0].privacy_at);
});
