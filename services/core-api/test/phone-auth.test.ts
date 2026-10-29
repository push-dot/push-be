import assert from "node:assert/strict";
import { test } from "node:test";

import { pkceChallenge } from "../src/crypto.ts";
import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { sha256Hex } from "../src/http.ts";
import { resetLimits } from "../src/ratelimit.ts";
import { createSmsSender } from "../src/sms/sender.ts";

const NOW = new Date("2026-10-21T00:00:00.000Z");
const PHONE = "+821012345678";
const OTHER = "+821099998888";
const DEV = "dev-token";
const OAUTH = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";

type Row = Record<string, unknown>;
type Err = { error: { code: string; message: string; details: { field?: string; retryAfterSec?: number } | null } };
type Session = { data: { created: boolean; accessToken: string; user: { id: string; accountType: string } } };
type Sent = { phone: string; code: string };

const env = (extra: Partial<CoreEnv> = {}): CoreEnv => ({
  APP_ENV: "production",
  ...extra,
});

const post = (path: string, body: unknown, headers?: HeadersInit): Request => new Request("https://core.example" + path, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const userRow = (extra: Row): Row => ({
  display_name: "Ada",
  locale: "ko",
  created_at: NOW.toISOString(),
  email: null,
  is_employer: false,
  plan: "FREE",
  subscription_status: "NONE",
  phone: null,
  provider: "phone",
  provider_subject: "",
  ...extra,
});

const createDb = () => {
  const users: Row[] = [];
  const codes: Row[] = [];
  const identities: Row[] = [];
  const exchange: Row[] = [];
  let now = NOW;

  const query: Deps["query"] = async (sql, params = []) => {
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("deletion_requested_at")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("SELECT sent_at FROM phone_codes")) {
      const rows = codes.filter((row) => row.phone === params[0]).sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)));
      return { rows: rows[0] ? [{ sent_at: rows[0].sent_at }] : [], rowCount: rows[0] ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE phone_codes SET consumed_at") && sql.includes("WHERE phone")) {
      for (const row of codes) if (row.phone === params[0] && row.consumed_at == null) row.consumed_at = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO phone_codes")) {
      codes.push({
        id: params[0], phone: params[1], code_hash: params[2], expires_at: params[3],
        attempts: 0, sent_at: params[4], consumed_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT id, code_hash")) {
      const open = codes.filter((row) => row.phone === params[0] && row.consumed_at == null)
        .sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)));
      return { rows: open[0] ? [open[0]] : [], rowCount: open[0] ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE phone_codes SET attempts")) {
      const row = codes.find((item) => item.id === params[0]);
      if (row) row.attempts = Number(row.attempts) + 1;
      return { rows: row ? [{ attempts: row.attempts }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE phone_codes SET consumed_at") && sql.includes("WHERE id")) {
      const row = codes.find((item) => item.id === params[0] && item.consumed_at == null);
      if (row) row.consumed_at = params[1];
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("SELECT id FROM users WHERE phone")) {
      const row = users.find((item) => item.phone === params[0] && item.is_employer === false);
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("INSERT INTO users")) {
      users.push(userRow({
        id: params[0], provider: "phone", provider_subject: params[1], phone: params[1], created_at: params[2], display_name: "user",
      }));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE users SET phone")) {
      const row = users.find((item) => item.id === params[0] && item.is_employer === false);
      if (!row) return { rows: [], rowCount: 0 };
      if (users.some((item) => item.phone === params[1] && item.id !== row.id && item.is_employer === false)) {
        const err = new Error("duplicate key value violates unique constraint");
        (err as { code?: string }).code = "23505";
        throw err;
      }
      row.phone = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT id, provider, provider_subject")) {
      const row = users.find((item) => item.id === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("SELECT user_id FROM user_identities")) {
      const row = identities.find((item) => item.provider === params[0] && item.provider_subject === params[1]);
      return { rows: row ? [{ user_id: row.user_id }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("FROM user_identities i")) {
      const row = identities.find((item) => item.provider === params[0] && item.provider_subject === params[1]);
      const user = row && users.find((item) => item.id === row.user_id);
      return { rows: user ? [{ id: user.id, is_employer: user.is_employer }] : [], rowCount: user ? 1 : 0 };
    }
    if (sql.startsWith("INSERT INTO user_identities")) {
      if (identities.some((item) => item.provider === params[1] && item.provider_subject === params[2])) {
        const err = new Error("duplicate key");
        (err as { code?: string }).code = "23505";
        throw err;
      }
      identities.push({ user_id: params[0], provider: params[1], provider_subject: params[2] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE user_identities SET user_id")) {
      const row = identities.find((item) => item.provider === params[1] && item.provider_subject === params[2] && item.user_id === params[3]);
      if (row) row.user_id = params[0];
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE users SET provider_subject")) {
      const row = users.find((item) => item.id === params[0] && item.provider_subject === params[2]);
      if (row) row.provider_subject = params[1];
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("FROM exchange_codes WHERE code")) {
      const row = exchange.find((item) => item.code === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE exchange_codes")) {
      const row = exchange.find((item) => item.code === params[0] && item.used_at == null);
      if (!row) return { rows: [], rowCount: 0 };
      row.used_at = params[1];
      return { rows: [{ code: row.code }], rowCount: 1 };
    }
    if (sql.includes("lower(email)")) {
      const row = users.find((item) => String(item.email ?? "").toLowerCase() === String(params[0]).toLowerCase());
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("provider_subject") && sql.includes("FROM users WHERE provider")) {
      const row = users.find((item) => item.provider === params[0] && item.provider_subject === params[1]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO refresh_tokens")) return { rows: [], rowCount: 1 };
    if (sql.includes("company_members") || sql.includes("FROM users WHERE id")) {
      const row = users.find((item) => item.id === params[0]);
      return { rows: row ? [{ ...row, company_id: null, company_role: null }] : [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };

  return { query, users, codes, identities, exchange, get now() { return now; }, set now(value: Date) { now = value; } };
};

const deps = (db: ReturnType<typeof createDb>, sent: Sent[]): Deps => ({
  query: db.query,
  now: () => db.now,
  sms: { send: async (phone, code) => { sent.push({ phone, code }); } },
});

const send = async (db: ReturnType<typeof createDb>, sent: Sent[], phone = PHONE, headers?: HeadersInit) => {
  resetLimits();
  return handle(post("/api/v1/auth/phone/send", { phone }, headers), env(), deps(db, sent));
};

const verify = async (db: ReturnType<typeof createDb>, sent: Sent[], code: string, phone = PHONE, headers?: HeadersInit) => {
  resetLimits();
  return handle(post("/api/v1/auth/phone/verify", { phone, code }, headers), env(), deps(db, sent));
};

test("send stores a hash, enforces cooldown, and refuses a bad phone", async () => {
  const db = createDb();
  const sent: Sent[] = [];
  const bad = await send(db, sent, "01012345678");
  assert.equal(bad.status, 400);
  assert.equal((await bad.json() as Err).error.details?.field, "phone");
  assert.equal(sent.length, 0);

  const first = await send(db, sent);
  assert.equal(first.status, 202);
  const body = await first.json() as { data: { cooldownSeconds: number; expiresAt: string } };
  assert.equal(body.data.cooldownSeconds, 168);
  assert.equal(body.data.expiresAt, "2026-10-21T00:03:00Z");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, PHONE);
  assert.match(sent[0].code, /^\d{6}$/);
  const stored = db.codes[0];
  assert.equal(stored.code_hash, await sha256Hex(`${stored.id}:${sent[0].code}`));
  assert.notEqual(stored.code_hash, sent[0].code);

  const again = await send(db, sent);
  assert.equal(again.status, 429);
  assert.equal((await again.json() as Err).error.details?.retryAfterSec, 168);
  assert.equal(sent.length, 1);
});

test("verify rejects a wrong code, an expired code, and too many attempts", async () => {
  const db = createDb();
  const sent: Sent[] = [];
  await send(db, sent);
  const wrong = sent[0].code === "000000" ? "000001" : "000000";
  const invalid = await verify(db, sent, wrong);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as Err).error.code, "PHONE_CODE_INVALID");
  assert.equal(db.codes[0].attempts, 1);
  assert.equal(db.users.length, 0);

  db.codes[0].expires_at = "2026-10-20T00:00:00.000Z";
  const expired = await verify(db, sent, sent[0].code);
  assert.equal(expired.status, 400);
  assert.equal((await expired.json() as Err).error.code, "PHONE_CODE_EXPIRED");

  db.codes[0].expires_at = "2026-10-21T00:03:00.000Z";
  db.codes[0].consumed_at = null;
  db.codes[0].attempts = 5;
  const limited = await verify(db, sent, wrong);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json() as Err).error.code, "RATE_LIMITED");
});

test("verify creates a personal account once, then logs into it", async () => {
  const db = createDb();
  const sent: Sent[] = [];
  await send(db, sent);
  const created = await verify(db, sent, sent[0].code);
  assert.equal(created.status, 200);
  const first = await created.json() as Session;
  assert.equal(first.data.created, true);
  assert.equal(first.data.user.accountType, "PERSONAL");
  assert.equal(db.users.length, 1);
  assert.equal(db.users[0].phone, PHONE);
  assert.equal(db.users[0].provider, "phone");
  assert.equal(db.users[0].id, first.data.user.id);
  assert.equal(db.identities.some((row) => row.provider === "phone" && row.provider_subject === PHONE), true);
  assert.ok(first.data.accessToken);

  db.now = new Date(NOW.getTime() + 169_000);
  await send(db, sent);
  const again = await verify(db, sent, sent[1].code);
  assert.equal(again.status, 200);
  const second = await again.json() as Session;
  assert.equal(second.data.created, false);
  assert.equal(second.data.user.id, first.data.user.id);
  assert.equal(db.users.length, 1);
});

test("an oauth session links a free phone and joins an existing phone account", async () => {
  const db = createDb();
  const sent: Sent[] = [];
  db.users.push(userRow({ id: OAUTH, provider: "google", provider_subject: "gsub", display_name: "Ada" }));
  const headers = { authorization: `Bearer ${DEV}` };
  const devEnv = env({ APP_ENV: "development", DEV_AUTH_TOKEN: DEV, DEV_USER_ID: OAUTH });
  resetLimits();
  const linked = await handle(post("/api/v1/auth/phone/send", { phone: PHONE }, headers), devEnv, deps(db, sent));
  assert.equal(linked.status, 202);
  resetLimits();
  const session = await handle(post("/api/v1/auth/phone/verify", { phone: PHONE, code: sent[0].code }, headers), devEnv, deps(db, sent));
  assert.equal(session.status, 200);
  const body = await session.json() as Session;
  assert.equal(body.data.created, false);
  assert.equal(body.data.user.id, OAUTH);
  assert.equal(db.users[0].phone, PHONE);

  db.users.push(userRow({ id: OWNER, provider: "phone", provider_subject: OTHER, phone: OTHER, display_name: "Bea" }));
  db.now = new Date(NOW.getTime() + 169_000);
  resetLimits();
  await handle(post("/api/v1/auth/phone/send", { phone: OTHER }, headers), devEnv, deps(db, sent));
  resetLimits();
  const joined = await handle(post("/api/v1/auth/phone/verify", { phone: OTHER, code: sent[1].code }, headers), devEnv, deps(db, sent));
  assert.equal(joined.status, 200);
  const joinedBody = await joined.json() as Session;
  assert.equal(joinedBody.data.created, false);
  assert.equal(joinedBody.data.user.id, OWNER);
  assert.equal(db.identities.some((row) => row.provider === "google" && row.provider_subject === "gsub" && row.user_id === OWNER), true);
  assert.equal(db.users.find((row) => row.id === OAUTH)?.provider_subject, `merged:${OAUTH}`);
});

test("an employer session cannot send a phone code", async () => {
  const db = createDb();
  const sent: Sent[] = [];
  db.users.push(userRow({ id: OAUTH, provider: "email", provider_subject: "a@push.app", is_employer: true, email: "a@push.app" }));
  resetLimits();
  const res = await handle(
    post("/api/v1/auth/phone/send", { phone: PHONE }, { authorization: `Bearer ${DEV}` }),
    env({ APP_ENV: "development", DEV_AUTH_TOKEN: DEV, DEV_USER_ID: OAUTH }),
    deps(db, sent),
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json() as Err).error.code, "FORBIDDEN");
  assert.equal(sent.length, 0);
  assert.equal(db.codes.length, 0);
});

test("production log mode does not print the code and send returns 503", async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await createSmsSender({ APP_ENV: "development", PHONE_SMS_MODE: "log" }).send(PHONE, "123456");
    assert.equal(lines.some((line) => line.includes("123456")), true);
    lines.length = 0;
    await assert.rejects(createSmsSender({ APP_ENV: "production", PHONE_SMS_MODE: "log" }).send(PHONE, "654321"));
    assert.equal(lines.some((line) => line.includes("654321")), false);
  } finally {
    console.log = orig;
  }
  const db = createDb();
  resetLimits();
  const res = await handle(post("/api/v1/auth/phone/send", { phone: PHONE }), env({ APP_ENV: "production", PHONE_SMS_MODE: "log" }), {
    query: db.query,
    now: () => db.now,
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json() as Err).error.code, "NOT_CONFIGURED");
  assert.equal(db.codes.length, 0);
});

test("oauth exchange prefers the phone account linked to that provider", async () => {
  const verifier = "verifier-verifier-verifier-verifier-verifier";
  const db = createDb();
  db.users.push(userRow({ id: OWNER, provider: "phone", provider_subject: PHONE, phone: PHONE, display_name: "Bea" }));
  db.users.push(userRow({ id: OAUTH, provider: "email", provider_subject: "ada@push.app", email: "ada@push.app", is_employer: true, display_name: "Employer" }));
  db.identities.push({ user_id: OWNER, provider: "google", provider_subject: "gsub" });
  db.exchange.push({
    code: "ex1",
    user_id: null,
    code_challenge: await pkceChallenge(verifier),
    expires_at: "2099-01-01T00:00:00.000Z",
    used_at: null,
    provider: "google",
    provider_subject: "gsub",
    email: "ada@push.app",
    email_verified: true,
    display_name: "Ada",
    account_type: "PERSONAL",
  });
  resetLimits();
  const res = await handle(post("/api/v1/auth/exchange", { code: "ex1", codeVerifier: verifier }), env(), {
    query: db.query,
    now: () => db.now,
  });
  assert.equal(res.status, 200);
  const body = await res.json() as Session;
  assert.equal(body.data.user.id, OWNER);
  assert.equal(db.users.length, 2);
});
