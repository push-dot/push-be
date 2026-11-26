import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { TestContext } from "node:test";

import type { Query } from "../src/db.ts";
import { handle } from "../src/handler.ts";
import type { CoreEnv, Deps } from "../src/handler.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { livePg } from "./parity/pg.ts";
import type { LivePg } from "./parity/pg.ts";

const URL_ = process.env.BILLING_PG_URL;
const NOW = Date.parse("2026-11-02T09:00:00.000Z");
const PRO = 27_000_000;
const ULTRA = 108_000_000;

const env: CoreEnv = { APP_ENV: "production", PAYMENTS_ENABLED: "1", IAP_PRODUCT_PRO: "play.pro", IAP_PRODUCT_ULTRA: "play.ultra" };

type Purchase = { productId: "play.pro" | "play.ultra"; linked?: string };

let pg: LivePg | undefined;
before(async () => { if (URL_) {pg = await livePg(URL_);} });
after(async () => { await pg?.close(); });

const authed = (userId: string): Query => async (sql, params = []) => {
  if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
  if (sql.includes("idempotency_keys")) {return sql.includes("INSERT") ? { rows: [{ id: "idem" }], rowCount: 1 } : { rows: [], rowCount: 0 };}
  if (sql.includes("access_tokens")) {
    return { rows: [{
      id: userId, display_name: "fixture", locale: "ko", plan: "FREE", subscription_status: "NONE", stripe_customer_id: null,
      period_ends_at: null, created_at: new Date(NOW).toISOString(), token_expires_at: "2099-01-01T00:00:00Z", is_employer: false,
      company_id: null, company_role: null,
    }], rowCount: 1 };
  }
  return pg!.query(sql, params);
};

const playWorld = async (t: TestContext, purchases: Record<string, Purchase>, shared?: string) => {
  if (!pg) {
    t.skip("set BILLING_PG_URL to a migrated Postgres");
    return null;
  }
  const userId = crypto.randomUUID();
  await pg.query("INSERT INTO users (id, provider, provider_subject, display_name) VALUES ($1, 'google', $2, 'fixture')", [userId, userId]);
  const tag = shared ?? userId.slice(0, 8);
  const hops: Array<string> = [];
  const tokenOf = (name: string): string => `${name}-${tag}`;
  let note = { type: "", token: "", productId: "" };
  const deps: Deps = {
    query: authed(userId), now: () => new Date(NOW),
    transaction: (work) => pg!.transaction!(work),
    stores: {
      verifyApple: async () => { throw new Error("apple"); },
      verifyGoogle: async (purchaseToken) => {
        const name = Object.keys(purchases).find((key) => tokenOf(key) === purchaseToken) ?? "";
        const purchase = purchases[name];
        return {
          productId: purchase.productId, originalTransactionId: purchaseToken, expiresAt: "2026-12-02T09:00:00.000Z", consumable: false,
          linkedPurchaseToken: purchase.linked ? tokenOf(purchase.linked) : undefined,
        };
      },
      googleLinkedToken: async (purchaseToken) => {
        const name = Object.keys(purchases).find((key) => tokenOf(key) === purchaseToken) ?? "";
        hops.push(name);
        const linked = purchases[name]?.linked;
        return linked ? tokenOf(linked) : undefined;
      },
      decodeAppleNotification: async () => { throw new Error("apple"); },
      decodeGoogleNotification: async () => ({ notificationType: note.type, purchaseToken: note.token, productId: note.productId, expiresAt: null }),
    },
  };
  const verify = async (name: string): Promise<number> => {
    resetLimits();
    const res = await handle(new Request("https://core.example/api/v1/billing/iap/verify", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ platform: "GOOGLE_PLAY", productId: purchases[name].productId, purchaseToken: tokenOf(name) }),
    }), env, deps);
    return res.status;
  };
  const notify = async (type: string, name: string): Promise<number> => {
    resetLimits();
    note = { type, token: tokenOf(name), productId: purchases[name].productId };
    const res = await handle(new Request("https://core.example/api/v1/billing/webhook/google-play", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }), env, deps);
    return res.status;
  };
  const ledger = async () => (await pg!.query("SELECT reference_id, amount_micro_credits FROM billing_ledger WHERE user_id = $1 ORDER BY seq", [userId])).rows
    .map((row) => [String(row.reference_id).replace(`-${tag}`, ""), Number(row.amount_micro_credits)]);
  const statuses = async () => Object.fromEntries((await pg!.query("SELECT original_transaction_id, status FROM iap_subscriptions WHERE user_id = $1", [userId])).rows
    .map((row) => [String(row.original_transaction_id).replace(`-${tag}`, ""), row.status]));
  const plan = async () => (await pg!.query("SELECT plan, subscription_status FROM users WHERE id = $1", [userId])).rows[0];
  return { tag, hops, verify, notify, ledger, statuses, plan };
};

const chainOf = (length: number) => {
  const names = ["a", ...Array.from({ length }, (_, index) => "l" + index), "z"];
  return Object.fromEntries(names.map((name, index): [string, Purchase] => [name, { productId: name === "z" ? "play.ultra" : "play.pro", linked: names[index - 1] }]));
};

test("a Play upgrade retires the replaced token and grants nothing by token, also on re-verify", async (t) => {
  const world = await playWorld(t, { a: { productId: "play.pro" }, b: { productId: "play.ultra", linked: "a" } });
  if (!world) {return;}
  assert.equal(await world.verify("a"), 200);
  assert.equal(await world.verify("b"), 200);
  assert.equal(await world.verify("b"), 200);
  assert.deepEqual(await world.statuses(), { a: "REPLACED", b: "ACTIVE" });
  assert.deepEqual(await world.ledger(), [["a", PRO], ["b", 0]]);
  assert.deepEqual(await world.plan(), { plan: "ULTRA", subscription_status: "ACTIVE" });
  assert.deepEqual(world.hops, []);
});

test("a Play downgrade and a switch back up grant nothing by token", async (t) => {
  const world = await playWorld(t, {
    a: { productId: "play.ultra" }, b: { productId: "play.pro", linked: "a" }, c: { productId: "play.ultra", linked: "b" },
  });
  if (!world) {return;}
  assert.equal(await world.verify("a"), 200);
  assert.equal(await world.verify("b"), 200);
  assert.deepEqual(await world.plan(), { plan: "PRO", subscription_status: "ACTIVE" });
  assert.equal(await world.verify("c"), 200);
  assert.equal(await world.verify("c"), 200);
  assert.deepEqual(await world.statuses(), { a: "REPLACED", b: "REPLACED", c: "ACTIVE" });
  assert.deepEqual(await world.ledger(), [["a", ULTRA], ["b", 0], ["c", 0]]);
  assert.deepEqual(await world.plan(), { plan: "ULTRA", subscription_status: "ACTIVE" });
});

test("a Play replacement linked to another account's purchase is refused and writes nothing", async (t) => {
  const purchases = {
    a: { productId: "play.pro" }, b: { productId: "play.ultra", linked: "a" }, c: { productId: "play.ultra" }, d: { productId: "play.ultra", linked: "c" },
    e: { productId: "play.ultra", linked: "d" },
  } satisfies Record<string, Purchase>;
  const owner = await playWorld(t, purchases);
  if (!owner) {return;}
  const other = await playWorld(t, purchases, owner.tag);
  if (!other) {return;}
  assert.equal(await owner.verify("a"), 200);
  assert.equal(await owner.verify("c"), 200);
  assert.equal(await other.verify("b"), 409);
  assert.equal(await other.verify("e"), 409);
  assert.deepEqual(other.hops, ["d"]);
  assert.deepEqual(await other.statuses(), {});
  assert.deepEqual(await other.ledger(), []);
  assert.deepEqual(await other.plan(), { plan: "FREE", subscription_status: "NONE" });
  assert.deepEqual(await owner.statuses(), { a: "ACTIVE", c: "ACTIVE" });
});

test("a Play replacement after a skipped verify follows the chain to the stale row", async (t) => {
  const world = await playWorld(t, {
    a: { productId: "play.pro" }, b: { productId: "play.ultra", linked: "a" }, c: { productId: "play.pro", linked: "b" },
  });
  if (!world) {return;}
  assert.equal(await world.verify("a"), 200);
  assert.equal(await world.verify("c"), 200);
  assert.deepEqual(world.hops, ["b"]);
  assert.deepEqual(await world.statuses(), { a: "REPLACED", c: "ACTIVE" });
  assert.deepEqual(await world.ledger(), [["a", PRO], ["c", 0]]);
  assert.deepEqual(await world.plan(), { plan: "PRO", subscription_status: "ACTIVE" });
});

test("the Play chain walk stops after five hops and still grants nothing", async (t) => {
  const near = await playWorld(t, chainOf(5));
  if (!near) {return;}
  assert.equal(await near.verify("a"), 200);
  assert.equal(await near.verify("z"), 200);
  assert.equal(near.hops.length, 5);
  assert.deepEqual(await near.statuses(), { a: "REPLACED", z: "ACTIVE" });
  assert.deepEqual(await near.ledger(), [["a", PRO], ["z", 0]]);
  const far = await playWorld(t, chainOf(6));
  if (!far) {return;}
  assert.equal(await far.verify("a"), 200);
  assert.equal(await far.verify("z"), 200);
  assert.equal(far.hops.length, 5);
  assert.deepEqual(await far.statuses(), { a: "ACTIVE", z: "ACTIVE" });
  assert.deepEqual(await far.ledger(), [["a", PRO], ["z", 0]]);
});

test("notices for a replaced Play token leave the plan, the row and the credits alone", async (t) => {
  const world = await playWorld(t, { a: { productId: "play.pro" }, b: { productId: "play.ultra", linked: "a" } });
  if (!world) {return;}
  assert.equal(await world.verify("a"), 200);
  assert.equal(await world.verify("b"), 200);
  assert.equal(await world.notify("EXPIRED", "a"), 200);
  assert.equal(await world.notify("RENEWAL", "a"), 200);
  assert.equal(await world.verify("a"), 400);
  assert.deepEqual(await world.statuses(), { a: "REPLACED", b: "ACTIVE" });
  assert.deepEqual(await world.ledger(), [["a", PRO], ["b", 0]]);
  assert.deepEqual(await world.plan(), { plan: "ULTRA", subscription_status: "ACTIVE" });
  assert.equal(await world.notify("EXPIRED", "b"), 200);
  assert.deepEqual(await world.plan(), { plan: "FREE", subscription_status: "CANCELED" });
});
