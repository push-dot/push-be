// Employer email signup on a migrated Postgres (BILLING_PG_URL): a later signup for the same address
// must not choose the password an earlier verify link sets.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { handle } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { livePg } from './parity/pg.ts';
import type { LivePg } from './parity/pg.ts';

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";
const env = { APP_ENV: "production", APP_WEB_ORIGIN: "https://web.example" };

let pg: LivePg | undefined;
before(async () => { if (URL_) {pg = await livePg(URL_);} });
after(async () => { await pg?.close(); });

const post = (path: string, body: unknown): Request => new Request("https://core.example/api/v1/auth/email/" + path, {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
  body: JSON.stringify(body),
});

test("the mailbox owner's password is the one set, whoever signed up for the address first", { skip: URL_ ? false : SKIP }, async () => {
  resetLimits();
  const email = `owner-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const links: Array<string> = [];
  const deps = { query: pg!.query, mailer: { send: async (mail: { text: string }) => { links.push(mail.text); } } };
  const signup = (displayName: string) =>
    handle(post("signup", { email, displayName, accountType: "EMPLOYER", agreeTerms: true }), env, deps);
  assert.equal((await signup("Intruder")).status, 202);
  assert.equal((await signup("Owner")).status, 202);
  const ownerToken = new URL(links[1]).searchParams.get("token");
  const verified = await handle(post("verify", { token: ownerToken, password: "owner-password-1" }), env, deps);
  assert.equal(verified.status, 200);
  resetLimits();
  assert.equal((await handle(post("login", { email, password: "owner-password-1" }), env, deps)).status, 200);
  assert.equal((await handle(post("login", { email, password: "intruder-password-2" }), env, deps)).status, 401);
  const intruderToken = new URL(links[0]).searchParams.get("token");
  assert.equal((await handle(post("verify", { token: intruderToken, password: "intruder-password-2" }), env, deps)).status, 401);
  await pg!.query("DELETE FROM users WHERE lower(email) = lower($1)", [email]);
});
