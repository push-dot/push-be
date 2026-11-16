// Phone code guesses on a migrated Postgres (BILLING_PG_URL): concurrent wrong codes still stop at the attempt limit.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { handle } from "../src/handler.ts";
import { sha256Hex } from "../src/http.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { livePg, type LivePg } from "./parity/pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const SKIP = "set BILLING_PG_URL to a migrated Postgres";

let pg: LivePg | undefined;
before(async () => { if (URL_) pg = await livePg(URL_, 30); });
after(async () => { await pg?.close(); });

const verify = (phone: string, code: string): Request => new Request("https://core.example/api/v1/auth/phone/verify", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 250)}` },
  body: JSON.stringify({ phone, code }),
});

test("thirty concurrent wrong codes get five comparisons, not thirty", { skip: URL_ ? false : SKIP }, async () => {
  resetLimits();
  const phone = `+8210${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const id = crypto.randomUUID();
  await pg!.query(
    "INSERT INTO phone_codes (id, phone, code_hash, expires_at, attempts, sent_at) VALUES ($1, $2, $3, now() + interval '3 minutes', 0, now())",
    [id, phone, await sha256Hex(`${id}:123456`)]);
  // Open every pooled connection first, so the thirty requests run side by side instead of queuing on a connect.
  await Promise.all(Array.from({ length: 30 }, () => pg!.query("SELECT pg_sleep(0.05)")));
  const wrong = Array.from({ length: 30 }, (_, i) => String(200000 + i));
  const answers = await Promise.all(wrong.map((code) => handle(verify(phone, code), { APP_ENV: "production" }, { query: pg!.query })));
  const codes = await Promise.all(answers.map(async (res) => (await res.json() as { error: { code: string } }).error.code));
  assert.equal(codes.filter((code) => code === "PHONE_CODE_INVALID").length, 5);
  assert.equal(codes.filter((code) => code === "RATE_LIMITED").length, 25);
  const right = await handle(verify(phone, "123456"), { APP_ENV: "production" }, { query: pg!.query });
  assert.equal(right.status, 429);
  await pg!.query("DELETE FROM phone_codes WHERE phone = $1", [phone]);
});
