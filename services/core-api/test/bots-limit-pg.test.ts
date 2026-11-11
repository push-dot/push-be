// Parallel company bot creates on FREE hit BOT_LIMIT at 3 bots; needs a real transaction (BILLING_PG_URL).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Query } from "../src/db.ts";
import { handle, type CoreEnv } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { livePg, type LivePg } from "./parity/pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const env: CoreEnv = { APP_ENV: "production" };
const NOW = "2026-11-10T00:00:00.000Z";

let pg: LivePg | undefined;
before(async () => { if (URL_) pg = await livePg(URL_); });
after(async () => { await pg?.close(); });

const dbFor = (userId: string): Query => async (sql, params = []) => {
  if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
  if (sql.includes("access_tokens")) {
    return {
      rows: [{
        id: userId, display_name: "race", locale: "ko", plan: "FREE", subscription_status: "NONE",
        stripe_customer_id: null, period_ends_at: null, created_at: NOW, token_expires_at: "2099-01-01T00:00:00Z",
        is_employer: false, company_id: null, company_role: null,
      }],
      rowCount: 1,
    };
  }
  if (sql.includes("idempotency_keys") && sql.includes("INSERT")) {
    return { rows: [{ id: crypto.randomUUID() }], rowCount: 1 };
  }
  if (sql.includes("idempotency_keys")) return { rows: [], rowCount: 0 };
  return pg!.query(sql, params);
};

const createBot = (userId: string, key: string) => {
  resetLimits();
  return handle(new Request("https://core.example/api/v1/bots", {
    method: "POST",
    headers: {
      authorization: "Bearer bot-limit-race",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({ companyName: "Acme" }),
  }), env, { query: dbFor(userId), transaction: pg!.transaction, now: () => new Date(NOW) });
};

test("parallel FREE bot creates allow only one more company bot at the limit", async (t) => {
  if (!pg) return t.skip("set BILLING_PG_URL to a migrated Postgres");
  const user = crypto.randomUUID();
  await pg.query(
    "INSERT INTO users (id, provider, provider_subject, display_name, plan, created_at) VALUES ($1::uuid, 'test', $1::uuid::text, 'bot limit', 'FREE', $2::timestamptz)",
    [user, NOW],
  );
  for (let i = 0; i < 2; i++) {
    await pg.query(
      `INSERT INTO bots (id, user_id, kind, company_name, display_name, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'company', 'Acme', $3, $4::timestamptz, $4::timestamptz)`,
      [crypto.randomUUID(), user, `seed ${i}`, NOW],
    );
  }
  const [a, b] = await Promise.all([
    createBot(user, crypto.randomUUID()),
    createBot(user, crypto.randomUUID()),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 403]);
  const bodies = await Promise.all([a.json(), b.json()]) as { error?: { code: string } }[];
  const limited = bodies.find((body) => body.error?.code === "BOT_LIMIT");
  assert.ok(limited);
  const count = await pg.query(
    "SELECT count(*)::int AS n FROM bots WHERE user_id = $1::uuid AND kind = 'company' AND deleted_at IS NULL",
    [user],
  );
  assert.equal(count.rows[0].n, 3);
  await pg.query("DELETE FROM users WHERE id = $1::uuid", [user]);
});
