import assert from "node:assert/strict";
import { test } from "node:test";

import { pkceChallenge } from "../src/crypto.ts";
import { handle, type CoreEnv, type Deps } from "../src/handler.ts";
import { createMailer } from "../src/mail/mailer.ts";
import { resetLimits } from "../src/ratelimit.ts";

const NOW = new Date("2026-10-21T00:00:00Z");
const EMAIL = "a@push.app";
const PASSWORD = "secret123";

type Row = Record<string, unknown>;
type Call = { sql: string; params: unknown[] };
type Mail = { to: string; subject: string; text: string; html: string };
type Err = { error: { code: string; message: string; details: { field?: string; accountType?: string } | null } };
type Session = { data: { accessToken: string; refreshToken: string; expiresIn: number; user: { id: string; accountType: string; companyId: string | null; companyRole: string | null } } };

const env = (extra: Partial<CoreEnv> = {}): CoreEnv => ({
  APP_ENV: "production",
  MANAGED_AI: "1",
  MANAGED_GO: "0",
  GOOGLE_CLIENT_ID: "gid",
  GOOGLE_CLIENT_SECRET: "gsec",
  GITHUB_CLIENT_ID: "hid",
  GITHUB_CLIENT_SECRET: "hsec",
  ...extra,
});

const post = (path: string, body: unknown, headers?: HeadersInit): Request => new Request("https://core.example" + path, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const signupBody = (extra: Record<string, unknown> = {}) => ({
  email: EMAIL,
  password: PASSWORD,
  accountType: "PERSONAL",
  displayName: "Ada",
  consentReference: true,
  ...extra,
});

const userRow = (extra: Row = {}): Row => ({
  id: "11111111-1111-4111-8111-111111111111",
  provider: "email",
  provider_subject: EMAIL,
  display_name: "Ada",
  locale: "ko",
  created_at: NOW.toISOString(),
  email: EMAIL,
  email_verified_at: NOW.toISOString(),
  is_employer: false,
  password_hash: "x",
  plan: "FREE",
  subscription_status: "NONE",
  stripe_customer_id: null,
  period_ends_at: null,
  company_id: null,
  company_role: null,
  ...extra,
});

const createDb = () => {
  const users: Row[] = [];
  const signups: Row[] = [];
  const tokens: Row[] = [];
  const consents: Row[] = [];
  const refresh: Row[] = [];
  const access: Row[] = [];
  const states: Row[] = [];
  const codes: Row[] = [];
  const sqls: Call[] = [];

  const byEmail = (email: unknown): Row | undefined =>
    users.find((row) => String(row.email).toLowerCase() === String(email).toLowerCase());

  const query: Deps["query"] = async (sql, params = []) => {
    sqls.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("deletion_requested_at")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("INSERT INTO email_signups")) {
      const [id, email, passwordHash, isEmployer, displayName, consent, createdAt] = params;
      const existing = signups.find((row) => row.email === email);
      if (existing) {
        Object.assign(existing, {
          password_hash: passwordHash,
          is_employer: isEmployer,
          display_name: displayName,
          consent_reference: consent,
          created_at: createdAt,
        });
        return { rows: [{ id: existing.id }], rowCount: 1 };
      }
      signups.push({
        id, email, password_hash: passwordHash, is_employer: isEmployer,
        display_name: displayName, consent_reference: consent, created_at: createdAt,
      });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM email_tokens")) {
      for (let i = tokens.length - 1; i >= 0; i--) {
        if (tokens[i].signup_id === params[0]) tokens.splice(i, 1);
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO email_tokens")) {
      tokens.push({
        id: params[0], user_id: params[1], signup_id: params[2], kind: params[3],
        token_hash: params[4], expires_at: params[5], used_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("email_tokens") && sql.includes("email_signups")) {
      const token = tokens.find((row) => row.token_hash === params[0] && row.kind === "VERIFY");
      if (!token) return { rows: [], rowCount: 0 };
      const signup = signups.find((row) => row.id === token.signup_id);
      if (!signup) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: token.id,
          used_at: token.used_at,
          expires_at: token.expires_at,
          signup_id: token.signup_id,
          email: signup.email,
          password_hash: signup.password_hash,
          is_employer: signup.is_employer,
          display_name: signup.display_name,
          consent_reference: signup.consent_reference,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("email_tokens") && sql.includes("'RESET'")) {
      const token = tokens.find((row) => row.token_hash === params[0] && row.kind === "RESET");
      return { rows: token ? [token] : [], rowCount: token ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE email_tokens")) {
      const token = tokens.find((row) => row.id === params[0] && row.used_at == null);
      if (!token) return { rows: [], rowCount: 0 };
      token.used_at = params[1];
      return { rows: [{ id: token.id }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO users")) {
      users.push(userRow({
        id: params[0],
        provider: params[1],
        provider_subject: params[2],
        display_name: params[3],
        locale: params[4],
        created_at: params[5],
        email: params[6],
        email_verified_at: params[7],
        is_employer: params[8],
        password_hash: params[9],
      }));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO user_consents")) {
      consents.push({ user_id: params[0], reference_data: params[1], updated_at: params[2] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE users SET password_hash")) {
      const user = users.find((row) => row.id === params[0]);
      if (user) user.password_hash = params[1];
      return { rows: [], rowCount: user ? 1 : 0 };
    }
    if (sql.includes("FROM users") && sql.includes("lower(email)")) {
      const row = byEmail(params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("FROM email_signups")) {
      const row = signups.find((item) => String(item.email).toLowerCase() === String(params[0]).toLowerCase());
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("INSERT INTO exchange_codes")) {
      codes.push({
        code: params[0], user_id: params[1], code_challenge: params[2], expires_at: params[3],
        used_at: null, created_at: params[4], provider: params[5], provider_subject: params[6],
        email: params[7], email_verified: params[8], display_name: params[9], account_type: params[10],
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM exchange_codes")) {
      const row = codes.find((item) => item.code === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("provider_subject")) {
      const row = users.find((item) => item.provider === params[0] && item.provider_subject === params[1]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO refresh_tokens")) {
      refresh.push({ id: params[0], user_id: params[1], token_hash: params[2], expires_at: params[3], revoked_at: null });
      access.push({ id: params[5], user_id: params[1], token_hash: params[6], expires_at: params[7] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE refresh_tokens") && sql.includes("revoked_at")) {
      for (const row of refresh) {
        if (row.user_id === params[0] && row.revoked_at == null) row.revoked_at = params[1];
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE access_tokens")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM access_tokens")) {
      const token = access.find((row) => row.token_hash === params[0]);
      const user = token && users.find((row) => row.id === token.user_id);
      if (!token || !user) return { rows: [], rowCount: 0 };
      return { rows: [{ ...user, token_expires_at: token.expires_at }], rowCount: 1 };
    }
    if (sql.includes("FROM users WHERE id")) {
      const user = users.find((row) => row.id === params[0]);
      return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
    }
    if (sql.startsWith("INSERT INTO oauth_states")) {
      states.push({
        state: params[0], provider: params[1], code_challenge: params[2], redirect_uri: params[3],
        final_uri: params[4], expires_at: params[5], created_at: params[6], account_type: params[7],
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM oauth_states")) {
      const row = states.find((item) => item.state === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("DELETE FROM oauth_states")) {
      const index = states.findIndex((item) => item.state === params[0]);
      if (index >= 0) states.splice(index, 1);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE exchange_codes")) {
      const row = codes.find((item) => item.code === params[0] && item.used_at == null);
      if (!row) return { rows: [], rowCount: 0 };
      row.used_at = params[1];
      return { rows: [{ code: row.code }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  return { query, sqls, users, signups, tokens, consents, refresh, states, codes };
};

const deps = (db: ReturnType<typeof createDb>, mailer?: { send(mail: Mail): Promise<void> }, fetchImpl?: typeof fetch): Deps => ({
  query: db.query,
  now: () => NOW,
  mailer,
  fetch: fetchImpl,
});

const tokenFrom = (mail: Mail): string => {
  const url = mail.text.match(/https?:\/\/\S+/)?.[0] ?? "";
  const token = new URL(url).searchParams.get("token");
  assert.ok(token);
  return token;
};

const calls = (db: ReturnType<typeof createDb>, needle: string): Call[] =>
  db.sqls.filter((call) => call.sql.includes(needle));

test("signup accepts a personal account and rejects a short password", async () => {
  resetLimits();
  const sent: Mail[] = [];
  const db = createDb();
  const mailer = { send: async (mail: Mail) => { sent.push(mail); } };
  const res = await handle(
    post("/api/v1/auth/email/signup", signupBody()),
    env({ APP_WEB_ORIGIN: "http://web.example" }),
    deps(db, mailer),
  );
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { data: { accepted: true } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, EMAIL);
  assert.match(sent[0].text, /^http:\/\/web\.example\/auth\/verify\?token=/);
  assert.match(sent[0].html, /\/auth\/verify\?token=/);
  assert.equal(db.users.length, 0);
  assert.equal(db.signups.length, 1);
  const insert = db.sqls.find((call) => call.sql.startsWith("INSERT INTO email_signups"));
  assert.ok(insert);
  assert.match(insert.sql, /ON CONFLICT \(email\)/);
  const stored = String(insert.params[2]);
  const parts = stored.split("$");
  assert.equal(parts[0], "pbkdf2");
  assert.equal(parts[1], "210000");
  assert.equal(Buffer.from(parts[2], "base64").length, 16);
  assert.equal(Buffer.from(parts[3], "base64").length, 32);
  const tokenInsert = db.sqls.find((call) => call.sql.startsWith("INSERT INTO email_tokens"));
  assert.ok(tokenInsert);
  assert.equal(tokenInsert.params[1], null);
  assert.equal(tokenInsert.params[2], db.signups[0].id);
  assert.equal(tokenInsert.params[3], "VERIFY");
  assert.equal(tokenInsert.params[5], "2026-10-22T00:00:00.000Z");

  resetLimits();
  const bad = await handle(
    post("/api/v1/auth/email/signup", signupBody({ password: "short" })),
    env(),
    deps(db, mailer),
  );
  const body = await bad.json() as Err;
  assert.equal(bad.status, 400);
  assert.equal(body.error.code, "VALIDATION_ERROR");
  assert.equal(body.error.details?.field, "password");
  assert.equal(sent.length, 1);

  resetLimits();
  const long = await handle(
    post("/api/v1/auth/email/signup", signupBody({ password: "x".repeat(129) })),
    env(),
    deps(db, mailer),
  );
  assert.equal(long.status, 400);
  assert.equal((await long.json() as Err).error.details?.field, "password");
});

test("signup replaces a pending row instead of returning 409", async () => {
  resetLimits();
  const sent: Mail[] = [];
  const db = createDb();
  const mailer = { send: async (mail: Mail) => { sent.push(mail); } };
  const first = await handle(post("/api/v1/auth/email/signup", signupBody()), env(), deps(db, mailer));
  resetLimits();
  const second = await handle(
    post("/api/v1/auth/email/signup", signupBody({ password: "another123", displayName: "Ada 2" })),
    env(),
    deps(db, mailer),
  );
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(db.signups.length, 1);
  assert.equal(db.signups[0].display_name, "Ada 2");
  assert.equal(sent.length, 2);
  assert.equal(db.users.length, 0);
});

test("signup reports the existing account type", async () => {
  resetLimits();
  const sent: Mail[] = [];
  const db = createDb();
  const mailer = { send: async (mail: Mail) => { sent.push(mail); } };
  db.users.push(userRow({ is_employer: false }));
  const personal = await handle(post("/api/v1/auth/email/signup", signupBody()), env(), deps(db, mailer));
  const personalBody = await personal.json() as Err;
  assert.equal(personal.status, 409);
  assert.equal(personalBody.error.code, "EMAIL_TAKEN");
  assert.equal(personalBody.error.details?.accountType, "PERSONAL");
  assert.equal(personalBody.error.message, "이 이메일은 개인 계정으로 가입되어 있어요");

  resetLimits();
  db.users[0].is_employer = true;
  const employer = await handle(
    post("/api/v1/auth/email/signup", signupBody({ accountType: "EMPLOYER" })),
    env(),
    deps(db, mailer),
  );
  const employerBody = await employer.json() as Err;
  assert.equal(employer.status, 409);
  assert.equal(employerBody.error.code, "EMAIL_TAKEN");
  assert.equal(employerBody.error.details?.accountType, "EMPLOYER");
  assert.equal(employerBody.error.message, "이 이메일은 기업 계정으로 가입되어 있어요");
  assert.equal(sent.length, 0);
  assert.equal(calls(db, "INSERT INTO users").length, 0);
});

test("verify creates the email user and a second use is rejected", async () => {
  resetLimits();
  const sent: Mail[] = [];
  const db = createDb();
  const mailer = { send: async (mail: Mail) => { sent.push(mail); } };
  await handle(
    post("/api/v1/auth/email/signup", signupBody({ accountType: "EMPLOYER" })),
    env(),
    deps(db, mailer),
  );
  resetLimits();
  const res = await handle(post("/api/v1/auth/email/verify", { token: tokenFrom(sent[0]) }), env(), deps(db, mailer));
  assert.equal(res.status, 200);
  const body = await res.json() as Session;
  assert.equal(body.data.expiresIn, 900);
  assert.ok(body.data.accessToken);
  assert.ok(body.data.refreshToken);
  assert.equal(body.data.user.accountType, "EMPLOYER");
  assert.equal(body.data.user.companyId, null);
  assert.equal(body.data.user.companyRole, null);
  assert.equal(db.users.length, 1);
  const inserted = db.sqls.find((call) => call.sql.startsWith("INSERT INTO users"));
  assert.ok(inserted);
  assert.equal(inserted.params[1], "email");
  assert.equal(inserted.params[6], EMAIL);
  assert.equal(inserted.params[7], NOW.toISOString());
  assert.equal(inserted.params[8], true);
  assert.equal(inserted.params[9], db.signups[0].password_hash);
  assert.equal(db.consents.length, 1);
  assert.equal(db.consents[0].user_id, db.users[0].id);
  assert.equal(db.consents[0].reference_data, true);
  assert.equal(db.tokens[0].used_at, NOW.toISOString());
  assert.equal(body.data.user.id, db.users[0].id);

  resetLimits();
  const again = await handle(post("/api/v1/auth/email/verify", { token: tokenFrom(sent[0]) }), env(), deps(db, mailer));
  assert.equal(again.status, 401);
  assert.equal(db.users.length, 1);
});

test("login waits for verification and checks the password", async () => {
  resetLimits();
  const sent: Mail[] = [];
  const db = createDb();
  const mailer = { send: async (mail: Mail) => { sent.push(mail); } };
  await handle(post("/api/v1/auth/email/signup", signupBody()), env(), deps(db, mailer));
  resetLimits();
  const early = await handle(post("/api/v1/auth/email/login", { email: EMAIL, password: PASSWORD }), env(), deps(db, mailer));
  assert.equal(early.status, 403);
  assert.equal((await early.json() as Err).error.code, "EMAIL_NOT_VERIFIED");

  resetLimits();
  await handle(post("/api/v1/auth/email/verify", { token: tokenFrom(sent[0]) }), env(), deps(db, mailer));
  resetLimits();
  const wrong = await handle(post("/api/v1/auth/email/login", { email: EMAIL, password: "nope1234" }), env(), deps(db, mailer));
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json() as Err).error.code, "INVALID_CREDENTIALS");
  resetLimits();
  const ok = await handle(post("/api/v1/auth/email/login", { email: EMAIL, password: PASSWORD }), env(), deps(db, mailer));
  assert.equal(ok.status, 200);
  const body = await ok.json() as Session;
  assert.equal(body.data.user.accountType, "PERSONAL");
  assert.ok(body.data.accessToken);
});

test("password reset does not reveal unknown emails", async () => {
  resetLimits();
  const sent: Mail[] = [];
  const db = createDb();
  const mailer = { send: async (mail: Mail) => { sent.push(mail); } };
  const unknown = await handle(post("/api/v1/auth/email/password-reset", { email: "missing@push.app" }), env(), deps(db, mailer));
  assert.equal(unknown.status, 202);
  assert.deepEqual(await unknown.json(), { data: { accepted: true } });
  assert.equal(sent.length, 0);

  await handle(post("/api/v1/auth/email/signup", signupBody()), env(), deps(db, mailer));
  resetLimits();
  await handle(post("/api/v1/auth/email/verify", { token: tokenFrom(sent[0]) }), env(), deps(db, mailer));
  resetLimits();
  const known = await handle(post("/api/v1/auth/email/password-reset", { email: EMAIL }), env(), deps(db, mailer));
  assert.equal(known.status, 202);
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /\/auth\/reset\?token=/);
  const reset = db.sqls.find((call) => call.sql.startsWith("INSERT INTO email_tokens") && call.params[3] === "RESET");
  assert.ok(reset);
  assert.equal(reset.params[1], db.users[0].id);
  assert.equal(reset.params[2], null);
  assert.equal(reset.params[5], "2026-10-21T01:00:00.000Z");
});

test("password reset confirm changes the password and revokes refresh tokens", async () => {
  resetLimits();
  const sent: Mail[] = [];
  const db = createDb();
  const mailer = { send: async (mail: Mail) => { sent.push(mail); } };
  await handle(post("/api/v1/auth/email/signup", signupBody()), env(), deps(db, mailer));
  resetLimits();
  await handle(post("/api/v1/auth/email/verify", { token: tokenFrom(sent[0]) }), env(), deps(db, mailer));
  resetLimits();
  await handle(post("/api/v1/auth/email/password-reset", { email: EMAIL }), env(), deps(db, mailer));
  const previous = db.users[0].password_hash;
  const userId = db.users[0].id;
  const before = db.sqls.length;
  resetLimits();
  const res = await handle(
    post("/api/v1/auth/email/password-reset/confirm", { token: tokenFrom(sent[1]), password: "newpass123" }),
    env(),
    deps(db, mailer),
  );
  assert.equal(res.status, 204);
  assert.notEqual(db.users[0].password_hash, previous);
  const revoke = db.sqls.slice(before).find((call) => call.sql.startsWith("UPDATE refresh_tokens") && call.sql.includes("revoked_at"));
  assert.ok(revoke);
  assert.equal(revoke.params[0], userId);
  assert.ok(db.refresh.some((row) => row.user_id === userId));
  assert.ok(db.refresh.filter((row) => row.user_id === userId).every((row) => row.revoked_at != null));
  resetLimits();
  const oldLogin = await handle(post("/api/v1/auth/email/login", { email: EMAIL, password: PASSWORD }), env(), deps(db, mailer));
  assert.equal(oldLogin.status, 401);
  resetLimits();
  const next = await handle(post("/api/v1/auth/email/login", { email: EMAIL, password: "newpass123" }), env(), deps(db, mailer));
  assert.equal(next.status, 200);
});

test("github employer start is rejected and google stores the account type", async () => {
  resetLimits();
  const db = createDb();
  const denied = await handle(new Request(
    "https://core.example/api/v1/auth/github/start?codeChallengeMethod=S256&codeChallenge=abc&redirectUri=push://auth/callback&accountType=EMPLOYER",
  ), env(), deps(db));
  const deniedBody = await denied.json() as Err;
  assert.equal(denied.status, 400);
  assert.equal(deniedBody.error.code, "VALIDATION_ERROR");
  assert.equal(deniedBody.error.details?.field, "accountType");
  assert.equal(db.sqls.some((call) => call.sql.includes("oauth_states")), false);

  resetLimits();
  const ok = await handle(new Request(
    "https://core.example/api/v1/auth/google/start?codeChallengeMethod=S256&codeChallenge=abc&redirectUri=push://auth/callback&accountType=EMPLOYER",
  ), env(), deps(db));
  assert.equal(ok.status, 200);
  const insert = db.sqls.find((call) => call.sql.startsWith("INSERT INTO oauth_states"));
  assert.ok(insert);
  assert.match(insert.sql, /account_type/);
  assert.equal(insert.params[7], "EMPLOYER");

  resetLimits();
  const local = await handle(new Request(
    "https://core.example/api/v1/auth/google/start?codeChallengeMethod=S256&codeChallenge=abc&redirectUri=" + encodeURIComponent("http://127.0.0.1:5174/auth/callback"),
  ), env(), deps(db));
  assert.equal(local.status, 200);
  const personal = db.sqls.filter((call) => call.sql.startsWith("INSERT INTO oauth_states")).at(-1);
  assert.equal(personal?.params[7], "PERSONAL");

  resetLimits();
  const extra = await handle(new Request(
    "https://core.example/api/v1/auth/google/start?codeChallengeMethod=S256&codeChallenge=abc&redirectUri=" + encodeURIComponent("https://web.example/auth/callback"),
  ), env({ OAUTH_REDIRECT_ORIGINS: "https://web.example" }), deps(db));
  assert.equal(extra.status, 200);
  resetLimits();
  const evil = await handle(new Request(
    "https://core.example/api/v1/auth/google/start?codeChallengeMethod=S256&codeChallenge=abc&redirectUri=" + encodeURIComponent("https://evil.example/auth/callback"),
  ), env({ OAUTH_REDIRECT_ORIGINS: "https://web.example" }), deps(db));
  assert.equal(evil.status, 400);
  assert.equal((await evil.json() as Err).error.details?.field, "redirectUri");
});

const googleFetch = (verified: boolean) => async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("token")) return Response.json({ access_token: "ya29" });
  return Response.json({ sub: "gsub", email: "ada@push.app", email_verified: verified, name: "Ada" });
};

const exchangeCode = async (db: ReturnType<typeof createDb>, verified: boolean, verifier: string): Promise<string> => {
  const callback = await handle(
    new Request("https://core.example/api/v1/auth/google/callback?code=abc&state=s1"),
    env(),
    deps(db, undefined, googleFetch(verified) as typeof fetch),
  );
  assert.equal(callback.status, 302);
  assert.equal(calls(db, "INSERT INTO users").length, 0);
  const location = callback.headers.get("location") ?? "";
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);
  const inserted = db.sqls.find((call) => call.sql.startsWith("INSERT INTO exchange_codes"));
  assert.ok(inserted);
  assert.equal(inserted.params[1], null);
  assert.equal(inserted.params[2], await pkceChallenge(verifier));
  assert.equal(inserted.params[5], "google");
  assert.equal(inserted.params[6], "gsub");
  assert.equal(inserted.params[7], "ada@push.app");
  assert.equal(inserted.params[8], verified);
  assert.equal(inserted.params[10], "PERSONAL");
  return code;
};

test("exchange rejects unverified google email and links the same account type", async () => {
  const verifier = "verifier-verifier-verifier-verifier-verifier";
  const challenge = await pkceChallenge(verifier);
  resetLimits();
  const unverified = createDb();
  unverified.states.push({
    state: "s1", provider: "google", code_challenge: challenge,
    redirect_uri: "https://core.example/api/v1/auth/google/callback",
    final_uri: "push://auth/callback", expires_at: "2099-01-01T00:00:00Z", account_type: "PERSONAL",
  });
  const badCode = await exchangeCode(unverified, false, verifier);
  resetLimits();
  const bad = await handle(post("/api/v1/auth/exchange", { code: badCode, codeVerifier: verifier }), env(), deps(unverified));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json() as Err).error.code, "EMAIL_NOT_VERIFIED");
  assert.equal(unverified.users.length, 0);

  resetLimits();
  const taken = createDb();
  taken.users.push(userRow({ email: "ada@push.app", is_employer: true }));
  taken.states.push({
    state: "s1", provider: "google", code_challenge: challenge,
    redirect_uri: "https://core.example/api/v1/auth/google/callback",
    final_uri: "push://auth/callback", expires_at: "2099-01-01T00:00:00Z", account_type: "PERSONAL",
  });
  const takenCode = await exchangeCode(taken, true, verifier);
  resetLimits();
  const conflict = await handle(post("/api/v1/auth/exchange", { code: takenCode, codeVerifier: verifier }), env(), deps(taken));
  const conflictBody = await conflict.json() as Err;
  assert.equal(conflict.status, 409);
  assert.equal(conflictBody.error.code, "EMAIL_TAKEN");
  assert.equal(conflictBody.error.details?.accountType, "EMPLOYER");
  assert.equal(conflictBody.error.message, "이 이메일은 기업 계정으로 가입되어 있어요");
  assert.equal(taken.users.length, 1);
  assert.equal(calls(taken, "INSERT INTO users").length, 0);

  resetLimits();
  const linked = createDb();
  linked.users.push(userRow({ email: "ada@push.app", is_employer: false }));
  linked.states.push({
    state: "s1", provider: "google", code_challenge: challenge,
    redirect_uri: "https://core.example/api/v1/auth/google/callback",
    final_uri: "push://auth/callback", expires_at: "2099-01-01T00:00:00Z", account_type: "PERSONAL",
  });
  const linkedCode = await exchangeCode(linked, true, verifier);
  resetLimits();
  const session = await handle(post("/api/v1/auth/exchange", { code: linkedCode, codeVerifier: verifier }), env(), deps(linked));
  assert.equal(session.status, 200);
  const body = await session.json() as Session;
  assert.equal(body.data.user.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(body.data.user.accountType, "PERSONAL");
  assert.equal(linked.users.length, 1);
  assert.equal(calls(linked, "INSERT INTO users").length, 0);

  resetLimits();
  const created = createDb();
  created.states.push({
    state: "s1", provider: "google", code_challenge: challenge,
    redirect_uri: "https://core.example/api/v1/auth/google/callback",
    final_uri: "push://auth/callback", expires_at: "2099-01-01T00:00:00Z", account_type: "PERSONAL",
  });
  const createdCode = await exchangeCode(created, true, verifier);
  resetLimits();
  const made = await handle(post("/api/v1/auth/exchange", { code: createdCode, codeVerifier: verifier }), env(), deps(created));
  assert.equal(made.status, 200);
  assert.equal(created.users.length, 1);
  const inserted = created.sqls.find((call) => call.sql.startsWith("INSERT INTO users"));
  assert.ok(inserted);
  assert.deepEqual(inserted.params.slice(1), [
    "google", "gsub", "Ada", "ko", NOW.toISOString(), "ada@push.app", NOW.toISOString(), false, null,
  ]);
});

test("github callback keeps a missing email on the exchange code", async () => {
  const verifier = "verifier-verifier-verifier-verifier-verifier";
  const challenge = await pkceChallenge(verifier);
  resetLimits();
  const db = createDb();
  db.states.push({
    state: "s1", provider: "github", code_challenge: challenge,
    redirect_uri: "https://core.example/api/v1/auth/github/callback",
    final_uri: "push://auth/callback", expires_at: "2099-01-01T00:00:00Z", account_type: "PERSONAL",
  });
  const seen: { url: string; ua: string | null; auth: string | null }[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, ua: headers.get("user-agent"), auth: headers.get("authorization") });
    if (url.includes("access_token")) return Response.json({ access_token: "gho_x" });
    if (url.includes("/user/emails")) {
      return Response.json([
        { email: "other@push.app", primary: false, verified: true },
        { email: "Ada@push.app", primary: true, verified: true },
        { email: "nope@push.app", primary: true, verified: false },
      ]);
    }
    return Response.json({ id: 42, login: "ada" });
  };
  const callback = await handle(
    new Request("https://core.example/api/v1/auth/github/callback?code=abc&state=s1"),
    env(),
    deps(db, undefined, fetchImpl as typeof fetch),
  );
  assert.equal(callback.status, 302);
  const emails = seen.find((call) => call.url.includes("/user/emails"));
  assert.ok(emails);
  assert.equal(emails.ua, "push-be");
  assert.equal(emails.auth, "Bearer gho_x");
  const userCall = seen.find((call) => call.url.endsWith("/user"));
  assert.equal(userCall?.ua, "push-be");
  const inserted = db.sqls.find((call) => call.sql.startsWith("INSERT INTO exchange_codes"));
  assert.ok(inserted);
  assert.equal(inserted.params[1], null);
  assert.equal(inserted.params[5], "github");
  assert.equal(inserted.params[6], "42");
  assert.equal(inserted.params[7], "ada@push.app");
  assert.equal(inserted.params[8], true);
  const code = new URL(callback.headers.get("location") ?? "").searchParams.get("code");
  resetLimits();
  const session = await handle(post("/api/v1/auth/exchange", { code, codeVerifier: verifier }), env(), deps(db));
  assert.equal(session.status, 200);
  assert.equal(db.users[0].provider, "github");
  assert.equal(db.users[0].email, "ada@push.app");

  resetLimits();
  const bare = createDb();
  bare.states.push({
    state: "s1", provider: "github", code_challenge: challenge,
    redirect_uri: "https://core.example/api/v1/auth/github/callback",
    final_uri: "push://auth/callback", expires_at: "2099-01-01T00:00:00Z", account_type: "PERSONAL",
  });
  const objectEmails = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("access_token")) return Response.json({ access_token: "gho_x" });
    const ua = new Headers(init?.headers).get("user-agent");
    return ua ? Response.json({ id: 42, login: "ada" }) : new Response("forbidden", { status: 403 });
  };
  const again = await handle(
    new Request("https://core.example/api/v1/auth/github/callback?code=abc&state=s1"),
    env(),
    deps(bare, undefined, objectEmails as typeof fetch),
  );
  assert.equal(again.status, 302);
  const profile = bare.sqls.find((call) => call.sql.startsWith("INSERT INTO exchange_codes"));
  assert.equal(profile?.params[8], false);
  const bareCode = new URL(again.headers.get("location") ?? "").searchParams.get("code");
  resetLimits();
  const rejected = await handle(post("/api/v1/auth/exchange", { code: bareCode, codeVerifier: verifier }), env(), deps(bare));
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json() as Err).error.code, "EMAIL_NOT_VERIFIED");
  assert.equal(bare.users.length, 0);
});

test("auth me for an email user includes the company fields", async () => {
  resetLimits();
  const sent: Mail[] = [];
  const db = createDb();
  const mailer = { send: async (mail: Mail) => { sent.push(mail); } };
  await handle(post("/api/v1/auth/email/signup", signupBody({ consentReference: false })), env(), deps(db, mailer));
  resetLimits();
  const verified = await handle(post("/api/v1/auth/email/verify", { token: tokenFrom(sent[0]) }), env(), deps(db, mailer));
  const session = await verified.json() as Session;
  assert.equal(db.consents.length, 0);
  resetLimits();
  const me = await handle(new Request("https://core.example/api/v1/auth/me", {
    headers: { authorization: "Bearer " + session.data.accessToken },
  }), env(), deps(db, mailer));
  assert.equal(me.status, 200);
  const body = await me.json() as { data: { accountType: string; companyId: string | null; companyRole: string | null } };
  assert.equal(body.data.accountType, "PERSONAL");
  assert.equal(body.data.companyId, null);
  const meBody = body as { data: { email?: string; provider?: string; plan?: string } };
  assert.equal(meBody.data.email, EMAIL);
  assert.equal(meBody.data.provider, "email");
  assert.equal(meBody.data.plan, "FREE");
  assert.equal(body.data.companyRole, null);
  assert.ok(db.sqls.some((call) => call.sql.includes("FROM access_tokens") && call.sql.includes("company_members")));
});

test("a missing mail binding still accepts signup", async () => {
  resetLimits();
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const db = createDb();
    const res = await handle(post("/api/v1/auth/email/signup", signupBody()), env(), deps(db));
    assert.equal(res.status, 202);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /noreply@push.local/);
    assert.match(logs[0], /http:\/\/localhost:5174\/auth\/verify\?token=/);
  } finally {
    console.log = original;
  }
});

test("the EMAIL binding sends mail from MAIL_FROM", async () => {
  resetLimits();
  const sent: { to: string; from: string; subject: string; text: string; html: string }[] = [];
  const db = createDb();
  const res = await handle(
    post("/api/v1/auth/email/signup", signupBody()),
    env({
      MAIL_FROM: "noreply@push.app",
      EMAIL: { send: async (message) => { sent.push(message); } },
    }),
    deps(db),
  );
  assert.equal(res.status, 202);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, "noreply@push.app");
  assert.equal(sent[0].to, EMAIL);
  assert.match(sent[0].html, /\/auth\/verify\?token=/);
});

const KEY = "re_test_secret";
const FROM = "Push <no-reply@push.app>";

const asRequest = (input: RequestInfo | URL, init?: RequestInit): Request =>
  input instanceof Request ? input : new Request(input, init);

const blockLiveFetch = (): (() => void) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("live fetch");
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
};

test("RESEND_API_KEY posts the signup mail through the injected fetch", async () => {
  resetLimits();
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const restore = blockLiveFetch();
  try {
    const db = createDb();
    const res = await handle(
      post("/api/v1/auth/email/signup", signupBody()),
      env({ RESEND_API_KEY: KEY, MAIL_FROM: FROM }),
      deps(db, undefined, fetchImpl),
    );
    assert.equal(res.status, 202);
    assert.equal(calls.length, 1);
    const request = asRequest(calls[0].input, calls[0].init);
    const body = await request.json() as { from: string; to: string; subject: string; html: string; text: string };
    const token = new URL(body.text).searchParams.get("token");
    assert.equal(request.url, "https://api.resend.com/emails");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(typeof body.to, "string");
    assert.equal(body.from, FROM);
    assert.equal(body.to, EMAIL);
    assert.equal(body.subject, "이메일 인증");
    assert.match(body.text, /^http:\/\/localhost:5174\/auth\/verify\?token=/);
    assert.equal(body.html, `<p><a href="${body.text}">${body.text}</a></p>`);
    assert.ok(token);
    assert.equal(request.headers.get("idempotency-key"), token);
  } finally {
    restore();
  }
});

test("a Resend error status throws and the log has the status without the key", async () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  const fetchImpl = (async () => new Response(KEY, { status: 422 })) as typeof fetch;
  try {
    const mailer = createMailer({ RESEND_API_KEY: KEY, MAIL_FROM: FROM }, fetchImpl);
    await assert.rejects(() => mailer.send({
      to: EMAIL,
      subject: "이메일 인증",
      text: "http://localhost:5174/auth/verify?token=abc",
      html: "<p>x</p>",
      idempotencyKey: "abc",
    }));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /422/);
    assert.equal(logs[0].includes(KEY), false);
    assert.equal(logs[0].includes("Bearer"), false);
    assert.equal(logs[0].includes("Authorization"), false);
  } finally {
    console.log = original;
  }
});

test("RESEND_API_KEY skips the EMAIL binding", async () => {
  resetLimits();
  const sent: { to: string }[] = [];
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const restore = blockLiveFetch();
  try {
    const db = createDb();
    const res = await handle(
      post("/api/v1/auth/email/signup", signupBody()),
      env({
        RESEND_API_KEY: KEY,
        MAIL_FROM: FROM,
        EMAIL: { send: async (message) => { sent.push(message); } },
      }),
      deps(db, undefined, fetchImpl),
    );
    assert.equal(res.status, 202);
    assert.equal(sent.length, 0);
    assert.equal(calls.length, 1);
    const request = asRequest(calls[0].input, calls[0].init);
    assert.equal(request.url, "https://api.resend.com/emails");
  } finally {
    restore();
  }
});

test("a whitespace RESEND_API_KEY keeps the local mail log", async () => {
  resetLimits();
  const calls: unknown[] = [];
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  const fetchImpl = (async () => {
    calls.push(1);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const restore = blockLiveFetch();
  try {
    const db = createDb();
    const res = await handle(
      post("/api/v1/auth/email/signup", signupBody()),
      env({ RESEND_API_KEY: " \t\n " }),
      deps(db, undefined, fetchImpl),
    );
    assert.equal(res.status, 202);
    assert.equal(calls.length, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /noreply@push.local/);
  } finally {
    console.log = original;
    restore();
  }
});

test("mail without an idempotency key sends a uuid key", async () => {
  let header = "";
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    header = asRequest(input, init).headers.get("idempotency-key") ?? "";
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const mailer = createMailer({ RESEND_API_KEY: KEY, MAIL_FROM: FROM }, fetchImpl);
  await mailer.send({ to: EMAIL, subject: "s", text: "t", html: "h" });
  assert.match(header, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});
