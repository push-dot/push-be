// The web session cookie end to end on a migrated Postgres (BILLING_PG_URL).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { handle } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { livePg } from './parity/pg.ts';
import type { LivePg } from './parity/pg.ts';
import { readJson } from "../test-support/recorder.ts";
import type { Row } from "../test-support/recorder.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";
const env = { APP_ENV: "production", APP_WEB_ORIGIN: "https://web.example" };

let pg: LivePg | undefined;
before(async () => { if (URL_) {pg = await livePg(URL_);} });
after(async () => { await pg?.close(); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request("https://core.example/api/v1/auth/" + path, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers },
    body: JSON.stringify(body),
  });

const cookieOf = (res: Response): string => (res.headers.get("set-cookie") ?? "").split(";")[0];

test("a web session lives in the cookie: refresh rotates it, logout ends it", { skip: URL_ ? false : SKIP }, async () => {
  resetLimits();
  const email = `web-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const links: Array<string> = [];
  const deps = { query: pg!.query, mailer: { send: async (mail: { text: string }) => { links.push(mail.text); } } };
  await handle(post("email/signup", { email, displayName: "Web", accountType: "EMPLOYER", agreeTerms: true }), env, deps);
  const token = new URL(links[0]).searchParams.get("token");
  const web = { "x-csrf": "1" };

  const verified = await handle(post("email/verify", { token, password: "web-password-1" }, web), env, deps);
  assert.equal(verified.status, 200);
  assert.equal((await readJson<{ data: Row }>(verified)).data.refreshToken, undefined);
  const first = cookieOf(verified);
  assert.match(first, /^push_rt=.{20,}/);

  const refreshed = await handle(post("refresh", {}, { ...web, cookie: first }), env, deps);
  assert.equal(refreshed.status, 200);
  const second = cookieOf(refreshed);
  assert.notEqual(second, first);

  const forged = await handle(post("refresh", {}, { cookie: second }), env, deps);
  assert.equal(forged.status, 400, "the cookie alone, without the header, is not read");

  const out = await handle(post("logout", {}, { ...web, cookie: second }), env, deps);
  assert.equal(out.status, 204);
  assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
  resetLimits();
  const after = await handle(post("refresh", {}, { ...web, cookie: second }), env, deps);
  assert.equal(after.status, 401);
  await pg!.query("DELETE FROM users WHERE lower(email) = lower($1)", [email]);
});
