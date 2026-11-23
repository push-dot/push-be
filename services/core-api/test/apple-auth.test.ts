import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { test } from "node:test";

import type { DbValue } from "../src/db.ts";
import { pkceChallenge } from "../src/crypto.ts";
import { handle } from '../src/handler.ts';
import type { CoreEnv, Deps } from '../src/handler.ts';
import { resetLimits } from "../src/ratelimit.ts";
import { resetAppleJwks } from "../src/routes/apple-auth.ts";

const NOW = new Date("2026-10-21T00:00:00.000Z");
const CLIENT_ID = "com.push.web";
const BUNDLE_ID = "com.push.app";
const TEAM_ID = "TEAMID123";
const KEY_ID = "test-key";
const SUB = "apple-sub-1";
const RELAY = "relay@privaterelay.appleid.com";
const GOOGLE_ID = "11111111-1111-4111-8111-111111111111";
const VERIFIER = "apple-verifier-0123456789abcdef";
const NONCE = "raw-nonce-value";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString().replaceAll('\n', String.raw`\n`);
const PUBLIC_JWK = publicKey.export({ format: "jwk" });

type Row = Awaited<ReturnType<Deps["query"]>>["rows"][number];
type Claims = Record<string, string | number | boolean | undefined>;
type Err = { error: { code: string; message: string; details: { field?: string } | null } };
type Pending = { data: { pendingToken?: string; expiresIn?: number; user?: { id: string; accountType: string } } };
type Start = { data: { authorizationUrl: string; state: string } };

const keysDownFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes("/auth/keys")) {return Response.json({ error: "down" }, { status: 500 });}
  if (url.includes("/auth/token")) {return Response.json({ id_token: signJwt(claims({ aud: CLIENT_ID })) });}
  return Response.json({ error: "miss" }, { status: 500 });
};

const errOf = async (res: Response): Promise<Err> => {
  const body: Err = await res.json();
  return body;
};

const nonceClaim = createHash("sha256").update(NONCE).digest("hex");

const b64url = (value: string): string => Buffer.from(value).toString("base64url");

const signJwt = (claims: Claims, key: KeyObject = privateKey): string => {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: KEY_ID }));
  const body = b64url(JSON.stringify(claims));
  const input = `${header}.${body}`;
  const sig = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${sig.toString("base64url")}`;
};

const claims = (extra: Claims = {}) => ({
  iss: "https://appleid.apple.com",
  aud: BUNDLE_ID,
  exp: Math.floor(NOW.getTime() / 1000) + 3600,
  sub: SUB,
  nonce: nonceClaim,
  email: RELAY,
  email_verified: true,
  ...extra,
});

const env = (extra: Partial<CoreEnv> = {}): CoreEnv => ({
  APP_ENV: "production",
  APPLE_TEAM_ID: TEAM_ID,
  APPLE_KEY_ID: KEY_ID,
  APPLE_CLIENT_ID: CLIENT_ID,
  APPLE_BUNDLE_ID: BUNDLE_ID,
  APPLE_PRIVATE_KEY: PEM,
  PENDING_SIGNUP_SECRET: "pending-test-secret",
  ...extra,
});

const duplicate = (): Error => Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });

// Fake rows hold Json cells; a bound param that is not one becomes null.
const cell = (value: unknown): DbValue => (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null ? value : null);

const createDb = () => {
  const users: Array<Row> = [];
  const states: Array<Row> = [];
  const codes: Array<Row> = [];
  const claimed = new Set<unknown>();
  const tokenBodies: Array<string> = [];
  let idToken = "";

  const query: Deps["query"] = async (sql, params = []) => {
    const cells = params.map(cell);
    if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
    if (sql.includes("deletion_requested_at")) {return { rows: [], rowCount: 1 };}
    if (sql.startsWith("INSERT INTO notification_dedupes")) {
      if (claimed.has(cells[0])) {return { rows: [], rowCount: 0 };}
      claimed.add(params[0]);
      return { rows: [{ dedupe_key: cells[0] }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO oauth_states")) {
      states.push({
        state: cells[0],
        provider: cells[1],
        code_challenge: cells[2],
        redirect_uri: cells[3],
        final_uri: cells[4],
        expires_at: cells[5],
        account_type: cells[7],
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM oauth_states")) {
      const index = states.findIndex((row) => row.state === params[0]);
      if (index < 0) {return { rows: [], rowCount: 0 };}
      const [row] = states.splice(index, 1);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO exchange_codes")) {
      codes.push({
        code: cells[0],
        user_id: cells[1],
        code_challenge: cells[2],
        expires_at: cells[3],
        used_at: null,
        provider: cells[5],
        provider_subject: cells[6],
        email: cells[7],
        email_verified: cells[8],
        display_name: cells[9],
        account_type: cells[10],
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM exchange_codes")) {
      const row = codes.find((item) => item.code === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE exchange_codes")) {
      const row = codes.find((item) => item.code === params[0] && (item.used_at === null || item.used_at === undefined));
      if (!row) {return { rows: [], rowCount: 0 };}
      row.used_at = cells[1];
      return { rows: [{ code: row.code }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO users")) {
      const email = params[6];
      if (email && users.some((row) => String(row.email).toLowerCase() === String(email).toLowerCase())) {throw duplicate();}
      if (users.some((row) => row.provider === params[1] && row.provider_subject === params[2])) {throw duplicate();}
      users.push({
        id: cells[0],
        provider: cells[1],
        provider_subject: cells[2],
        display_name: cells[3],
        locale: cells[4],
        created_at: cells[5],
        email: cells[6],
        email_verified_at: cells[7],
        is_employer: cells[8],
        password_hash: cells[9],
        plan: "FREE",
        subscription_status: "NONE",
        stripe_customer_id: null,
        period_ends_at: null,
        company_id: null,
        company_role: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("provider_subject")) {
      const row = users.find((item) => item.provider === params[0] && item.provider_subject === params[1]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO refresh_tokens")) {return { rows: [], rowCount: 1 };}
    if (sql.includes("FROM users WHERE id")) {
      const row = users.find((item) => item.id === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/auth/keys")) {
      return Response.json({
        keys: [{ kty: PUBLIC_JWK.kty, crv: PUBLIC_JWK.crv, x: PUBLIC_JWK.x, y: PUBLIC_JWK.y, kid: KEY_ID, alg: "ES256", use: "sig" }],
      });
    }
    if (url.includes("/auth/token")) {
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
      tokenBodies.push(body);
      if (!idToken) {return Response.json({ error: "no" }, { status: 500 });}
      return Response.json({ id_token: idToken });
    }
    return Response.json({ error: "miss" }, { status: 500 });
  };

  return { users, states, codes, tokenBodies, query, fetchImpl, setToken: (token: string) => { idToken = token; } };
};

const deps = (db: ReturnType<typeof createDb>): Deps => ({
  query: db.query,
  now: () => NOW,
  fetch: db.fetchImpl,
});

const startUrl = (challenge: string, accountType = "PERSONAL"): string =>
  "https://core.example/api/v1/auth/apple/start?codeChallengeMethod=S256&codeChallenge="
  + encodeURIComponent(challenge)
  + "&redirectUri=" + encodeURIComponent("push://auth/callback")
  + "&accountType=" + accountType;

const prepare = (): void => {
  resetLimits();
  resetAppleJwks();
};

test("apple start returns a form_post url and rejects employers", async () => {
  prepare();
  const db = createDb();
  const challenge = await pkceChallenge(VERIFIER);
  const res = await handle(new Request(startUrl(challenge)), env(), deps(db));
  assert.equal(res.status, 200);
  const body: Start = await res.json();
  const url = new URL(body.data.authorizationUrl);
  assert.equal(url.origin + url.pathname, "https://appleid.apple.com/auth/authorize");
  assert.equal(url.searchParams.get("response_mode"), "form_post");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("scope"), "openid name email");
  assert.equal(url.searchParams.get("code_challenge"), challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), body.data.state);
  assert.equal(db.states[0]?.provider, "apple");

  prepare();
  const denied = await handle(new Request(startUrl(challenge, "EMPLOYER")), env(), deps(db));
  const deniedBody: Err = await denied.json();
  assert.equal(denied.status, 400);
  assert.equal(deniedBody.error.details?.field, "accountType");
  assert.equal(db.states.length, 1);

  prepare();
  const missing = await handle(new Request(startUrl(challenge)), env({ APPLE_CLIENT_ID: "" }), deps(createDb()));
  assert.equal(missing.status, 503);
  assert.equal((await errOf(missing)).error.code, "NOT_CONFIGURED");
});

test("apple form_post does not join an account that already has the email", async () => {
  prepare();
  const db = createDb();
  db.users.push({
    id: GOOGLE_ID,
    provider: "google",
    provider_subject: "gsub",
    display_name: "Ada",
    locale: "ko",
    created_at: NOW.toISOString(),
    email: RELAY,
    email_verified_at: NOW.toISOString(),
    is_employer: false,
    plan: "FREE",
    subscription_status: "NONE",
    company_id: null,
    company_role: null,
  });
  const challenge = await pkceChallenge(VERIFIER);
  const started = await handle(new Request(startUrl(challenge)), env(), deps(db));
  const start: Start = await started.json();
  db.setToken(signJwt(claims({ aud: CLIENT_ID, nonce: undefined })));
  const form = new URLSearchParams({
    code: "auth-code",
    state: start.data.state,
    user: JSON.stringify({ name: { firstName: "Ada", lastName: "Lovelace" } }),
  });
  const callback = await handle(new Request("https://core.example/api/v1/auth/apple/callback", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Bearer leftover" },
    body: form,
  }), env(), deps(db));
  assert.equal(callback.status, 302);
  const location = callback.headers.get("location") || "";
  assert.match(location, /^push:\/\/auth\/callback\?code=/);
  const posted = db.tokenBodies[0] || "";
  assert.match(posted, /grant_type=authorization_code/);
  assert.match(posted, /redirect_uri=/);
  const secret = new URLSearchParams(posted).get("client_secret") || "";
  assert.equal(secret.split(".").length, 3);
  assert.equal(db.codes[0]?.display_name, "Ada Lovelace");
  assert.equal(db.codes[0]?.email, RELAY);
  assert.equal(db.codes[0]?.account_type, "PERSONAL");
  const exchangeCode = new URL(location).searchParams.get("code");
  const exchanged = await handle(new Request("https://core.example/api/v1/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: exchangeCode, codeVerifier: VERIFIER }),
  }), env(), deps(db));
  assert.equal(exchanged.status, 200);
  const pending: Pending = await exchanged.json();
  assert.equal(typeof pending.data.pendingToken, "string");
  assert.equal(pending.data.expiresIn, 900);
  assert.equal(db.users.length, 1);
  assert.equal(db.users[0].id, GOOGLE_ID);
  assert.equal(db.users.some((row) => row.provider === "apple"), false);

  prepare();
  db.setToken(signJwt(claims({ email: undefined, email_verified: undefined })));
  const again = await handle(new Request("https://core.example/api/v1/auth/apple/native", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityToken: signJwt(claims({ email: undefined, email_verified: undefined })), nonce: NONCE }),
  }), env(), deps(db));
  assert.equal(again.status, 200);
  const second: Pending = await again.json();
  assert.equal(typeof second.data.pendingToken, "string");
  assert.equal(db.users.length, 1);
});

test("apple native verifies nonce audience and expiry", async () => {
  prepare();
  const db = createDb();
  const ok = await handle(new Request("https://core.example/api/v1/auth/apple/native", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityToken: signJwt(claims()), nonce: NONCE }),
  }), env(), deps(db));
  assert.equal(ok.status, 200);
  const session: Pending = await ok.json();
  assert.equal(typeof session.data.pendingToken, "string");
  assert.equal(session.data.expiresIn, 900);
  assert.equal(db.users.length, 0);

  db.users.push({
    id: GOOGLE_ID,
    provider: "apple",
    provider_subject: SUB,
    display_name: "Ada",
    locale: "ko",
    created_at: NOW.toISOString(),
    email: null,
    email_verified_at: null,
    is_employer: false,
    plan: "FREE",
    subscription_status: "NONE",
    company_id: null,
    company_role: null,
  });
  prepare();
  const back = await handle(new Request("https://core.example/api/v1/auth/apple/native", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityToken: signJwt(claims()), nonce: NONCE }),
  }), env(), deps(db));
  assert.equal(back.status, 200);
  const signedIn: Pending = await back.json();
  assert.equal(signedIn.data.pendingToken, undefined);
  assert.equal(signedIn.data.user?.id, GOOGLE_ID);
  assert.equal(db.users.length, 1);

  prepare();
  const badNonce = await handle(new Request("https://core.example/api/v1/auth/apple/native", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityToken: signJwt(claims()), nonce: "other-nonce" }),
  }), env(), deps(db));
  assert.equal(badNonce.status, 401);
  assert.equal((await errOf(badNonce)).error.message, "nonce mismatch");

  prepare();
  const expired = await handle(new Request("https://core.example/api/v1/auth/apple/native", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityToken: signJwt(claims({ exp: 1 })), nonce: NONCE }),
  }), env(), deps(db));
  assert.equal(expired.status, 401);
  assert.equal((await errOf(expired)).error.code, "TOKEN_EXPIRED");

  prepare();
  const wrongAud = await handle(new Request("https://core.example/api/v1/auth/apple/native", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityToken: signJwt(claims({ aud: "com.other.app" })), nonce: NONCE }),
  }), env(), deps(db));
  assert.equal(wrongAud.status, 401);
  assert.equal((await errOf(wrongAud)).error.message, "invalid identity token");

  prepare();
  const missing = await handle(new Request("https://core.example/api/v1/auth/apple/native", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityToken: signJwt(claims()), nonce: NONCE }),
  }), env({ APPLE_BUNDLE_ID: "" }), deps(createDb()));
  assert.equal(missing.status, 503);
  assert.equal((await errOf(missing)).error.code, "NOT_CONFIGURED");
});

test("apple callback failures stay closed", async () => {
  prepare();
  const getCallback = await handle(new Request("https://core.example/api/v1/auth/apple/callback?code=x&state=y"), env(), deps(createDb()));
  assert.equal(getCallback.status, 400);
  assert.equal((await errOf(getCallback)).error.message, "apple callback is POST form_post");

  prepare();
  const db = createDb();
  const challenge = await pkceChallenge(VERIFIER);
  const started = await handle(new Request(startUrl(challenge)), env(), deps(db));
  const start: Start = await started.json();
  const failedKeys = await handle(new Request("https://core.example/api/v1/auth/apple/callback", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: "auth-code", state: start.data.state }),
  }), env(), { query: db.query, now: () => NOW, fetch: keysDownFetch });
  assert.equal(failedKeys.status, 502);
  assert.equal((await errOf(failedKeys)).error.message, "apple jwks fetch failed");
  assert.equal(db.codes.length, 0);
});

test("an identity token logs in once", async () => {
  prepare();
  const db = createDb();
  const token = signJwt(claims());
  const login = () => handle(new Request("https://core.example/api/v1/auth/apple/native", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityToken: token, nonce: NONCE }),
  }), env(), deps(db));
  assert.equal((await login()).status, 200);
  const replay = await login();
  assert.equal(replay.status, 401);
  assert.equal((await errOf(replay)).error.code, "UNAUTHENTICATED");
});
