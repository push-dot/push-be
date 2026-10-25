import { parseTimeField, strictBody } from "../body.ts";
import { base64ToBytes, bytesToBase64, decryptAes, encryptAes, masterKey, verifyPkce } from "../crypto.ts";
import { one, query } from "../db.ts";
import { HttpError, data, fieldError, noContent, parseUuid, randomToken } from "../http.ts";
import { listPage, pageOf, ts } from "../page.ts";
import { formatJsonTimestamp, pyJson } from "../time.ts";
import type { Ctx } from "../types.ts";

const PURPOSE = "google";
const SCOPE_GMAIL = "https://www.googleapis.com/auth/gmail.readonly";
const SCOPE_CALENDAR = "https://www.googleapis.com/auth/calendar.events";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const APP_CALLBACK = "push://integrations/google/callback";
const WEB_CALLBACK = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/integrations\/google\/callback$/;
const STATE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const GI_COLS = "user_id, encode(access_ciphertext, 'base64') AS access_ciphertext, encode(access_nonce, 'base64') AS access_nonce, encode(refresh_ciphertext, 'base64') AS refresh_ciphertext, encode(refresh_nonce, 'base64') AS refresh_nonce, scopes, token_expires_at, gmail_history_id, calendar_sync_token, last_synced_at, created_at, updated_at";
const GM_COLS = "id, user_id, external_id, thread_id, application_id, sender, subject, snippet, received_at, created_at";
const EVENT_COLS = "id, user_id, revision, application_id, type, title, starts_at, ends_at, time_zone, source, external_id, notes, created_at, updated_at";

type Row = Record<string, unknown>;
type Integration = Row & { scopes: string[] };
type Tokens = { accessToken: string; refreshToken: string; expiresIn: number; scope: string };
type MessageMeta = { id: string; threadId: string; sender: string; subject: string; snippet: string; receivedAt: string | null };
type GoogleEvent = { id: string; status: string; summary: string; timeZone: string; startsAt: string; endsAt: string };

class SyncTokenInvalid extends Error {}

const notConfigured = (message: string): HttpError => new HttpError(503, "NOT_CONFIGURED", message);
const unauthenticated = (message: string): HttpError => new HttpError(401, "UNAUTHENTICATED", message);
const providerError = (message: string): HttpError => new HttpError(502, "PROVIDER_ERROR", message);
const integrationRequired = (): HttpError => new HttpError(409, "INTEGRATION_REQUIRED", "google account is not connected");
const notFound = (): HttpError => new HttpError(404, "NOT_FOUND", "resource not found");

const configured = (ctx: Ctx): boolean => Boolean(ctx.env.GOOGLE_CLIENT_ID && ctx.env.GOOGLE_CLIENT_SECRET);
const gmailBeta = (ctx: Ctx): boolean => ctx.env.GOOGLE_GMAIL_BETA_ENABLED === "true";
const http = (ctx: Ctx): typeof fetch => ctx.deps.fetch ?? fetch;
const addMs = (ctx: Ctx, ms: number): string => formatJsonTimestamp(new Date(ctx.now.getTime() + ms));

const routerCheck = (ctx: Ctx): void => {
  if (!configured(ctx)) throw notConfigured("google integration is not configured");
};

/** `GoogleService._check`: client credentials and the token cipher. */
const cipher = async (ctx: Ctx): Promise<CryptoKey> => {
  if (!configured(ctx)) throw notConfigured("google integration is not configured");
  if (!ctx.env.BYOK_MASTER_KEY) throw notConfigured("token encryption is not configured");
  return masterKey(ctx.env.BYOK_MASTER_KEY);
};

const seal = async (key: CryptoKey, text: string, userId: string): Promise<{ ct: string; nonce: string }> => {
  const out = await encryptAes(key, text, userId, PURPOSE);
  return { ct: bytesToBase64(out.ciphertext), nonce: bytesToBase64(out.nonce) };
};

const open = (key: CryptoKey, ct: unknown, nonce: unknown, userId: string): Promise<string> =>
  decryptAes(key, base64ToBytes(String(ct).replace(/\s+/g, "")), base64ToBytes(String(nonce).replace(/\s+/g, "")), userId, PURPOSE);

const loadIntegration = async (ctx: Ctx): Promise<Integration | null> => {
  const row = await one(ctx.deps.query, `SELECT ${GI_COLS} FROM google_integrations WHERE user_id = $1`, [ctx.user.id]);
  if (!row) return null;
  return { ...row, scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [] };
};

const putIntegration = async (ctx: Ctx, gi: Row): Promise<void> => {
  await query(ctx.deps.query,
    "INSERT INTO google_integrations (user_id, access_ciphertext, access_nonce, refresh_ciphertext, refresh_nonce, scopes, token_expires_at, gmail_history_id, calendar_sync_token, last_synced_at, created_at, updated_at) VALUES ($1, decode($2, 'base64'), decode($3, 'base64'), decode($4, 'base64'), decode($5, 'base64'), $6::jsonb, $7, $8, $9, $10, $11, $12) ON CONFLICT (user_id) DO UPDATE SET access_ciphertext = decode($2, 'base64'), access_nonce = decode($3, 'base64'), refresh_ciphertext = decode($4, 'base64'), refresh_nonce = decode($5, 'base64'), scopes = $6::jsonb, token_expires_at = $7, gmail_history_id = $8, calendar_sync_token = $9, last_synced_at = $10, updated_at = $12",
    [ctx.user.id, gi.access_ciphertext, gi.access_nonce, gi.refresh_ciphertext ?? null, gi.refresh_nonce ?? null,
      JSON.stringify(gi.scopes ?? []), gi.token_expires_at == null ? null : ts(gi.token_expires_at), gi.gmail_history_id ?? null,
      gi.calendar_sync_token ?? null, gi.last_synced_at == null ? null : ts(gi.last_synced_at), ts(gi.created_at), ts(gi.updated_at)]);
};

const statusOf = (ctx: Ctx, gi: Integration | null): Row => {
  const beta = gmailBeta(ctx);
  if (!gi) {
    return { enabled: configured(ctx), connected: false, scopes: [], gmailStatus: beta ? "DISCONNECTED" : "DISABLED", calendarStatus: "DISCONNECTED", lastSyncedAt: null };
  }
  return {
    enabled: configured(ctx),
    connected: true,
    scopes: gi.scopes,
    gmailStatus: beta ? (gi.scopes.includes(SCOPE_GMAIL) ? "CONNECTED" : "DISCONNECTED") : "DISABLED",
    calendarStatus: gi.scopes.includes(SCOPE_CALENDAR) ? "CONNECTED" : "DISCONNECTED",
    lastSyncedAt: ts(gi.last_synced_at),
  };
};

const messageDto = (row: Row): Row => ({
  id: String(row.id),
  threadId: String(row.thread_id ?? ""),
  applicationId: row.application_id == null ? null : String(row.application_id),
  sender: String(row.sender ?? ""),
  subject: String(row.subject ?? ""),
  snippet: String(row.snippet ?? ""),
  receivedAt: ts(row.received_at),
  createdAt: ts(row.created_at),
});

const eventDto = (row: Row): Row => ({
  id: String(row.id),
  revision: Number(row.revision),
  applicationId: row.application_id == null ? null : String(row.application_id),
  type: String(row.type),
  title: String(row.title ?? ""),
  startsAt: ts(row.starts_at),
  endsAt: ts(row.ends_at),
  timeZone: String(row.time_zone ?? "UTC"),
  source: String(row.source ?? "LOCAL"),
  externalId: row.external_id == null ? null : String(row.external_id),
  notes: String(row.notes ?? ""),
  createdAt: ts(row.created_at),
  updatedAt: ts(row.updated_at),
});


const requireConnection = async (ctx: Ctx): Promise<Integration> => {
  const gi = await loadIntegration(ctx);
  if (!gi) throw integrationRequired();
  return gi;
};

// Google HTTP calls, the same requests app/infrastructure/google_client.py sends.

const tokenRequest = async (ctx: Ctx, form: Record<string, string>): Promise<Tokens> => {
  const res = await http(ctx)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const body = await res.json().catch(() => ({})) as Row;
  if (res.status !== 200 || !body.access_token) throw new Error(`google token request failed: status ${res.status}`);
  return {
    accessToken: String(body.access_token),
    refreshToken: String(body.refresh_token ?? ""),
    expiresIn: Number(body.expires_in ?? 0),
    scope: String(body.scope ?? ""),
  };
};

const getJson = async (ctx: Ctx, token: string, url: string): Promise<{ status: number; body: Row }> => {
  const res = await http(ctx)(url, { headers: { authorization: "Bearer " + token } });
  const body = await res.json().catch(() => ({})) as Row;
  return { status: res.status, body: body && typeof body === "object" ? body : {} };
};

const listMessageIds = async (ctx: Ctx, token: string, pageToken: string): Promise<{ ids: string[]; next: string; history: string }> => {
  let url = "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50";
  if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);
  const { status, body } = await getJson(ctx, token, url);
  if (status !== 200) throw new Error(`gmail list failed: status ${status}`);
  const messages = Array.isArray(body.messages) ? body.messages as Row[] : [];
  return { ids: messages.map((m) => String(m.id)), next: String(body.nextPageToken ?? ""), history: String(body.historyId ?? "") };
};

const getMessage = async (ctx: Ctx, token: string, id: string): Promise<MessageMeta> => {
  const url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + encodeURIComponent(id)
    + "?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date";
  const { status, body } = await getJson(ctx, token, url);
  if (status !== 200) throw new Error(`gmail get failed: status ${status}`);
  const meta: MessageMeta = {
    id: String(body.id ?? ""), threadId: String(body.threadId ?? ""), sender: "", subject: "", snippet: String(body.snippet ?? ""), receivedAt: null,
  };
  const headers = ((body.payload ?? {}) as Row).headers;
  for (const h of Array.isArray(headers) ? headers as Row[] : []) {
    const name = String(h.name ?? "").toLowerCase();
    if (name === "from") meta.sender = String(h.value ?? "");
    else if (name === "subject") meta.subject = String(h.value ?? "");
  }
  const internal = String(body.internalDate ?? "");
  if (/^[+-]?\d+$/.test(internal.trim())) meta.receivedAt = formatJsonTimestamp(new Date(Number(internal)));
  return meta;
};

const googleTime = (dateTime: string, date: string): string => {
  if (dateTime) {
    try { return parseTimeField(dateTime, "dateTime"); } catch { /* fall through */ }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    try { return parseTimeField(date, "date"); } catch { /* fall through */ }
  }
  return formatJsonTimestamp(new Date(0));
};

const listEvents = async (ctx: Ctx, token: string, syncToken: string): Promise<{ events: GoogleEvent[]; next: string }> => {
  let url = "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=100";
  if (syncToken) url += "&syncToken=" + encodeURIComponent(syncToken);
  else {
    const since = new Date(ctx.now.getTime() - 90 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    url += "&singleEvents=true&timeMin=" + encodeURIComponent(since);
  }
  const { status, body } = await getJson(ctx, token, url);
  if (status === 410) throw new SyncTokenInvalid();
  if (status !== 200) throw new Error(`calendar list failed: status ${status}`);
  const items = Array.isArray(body.items) ? body.items as Row[] : [];
  const events = items.map((it) => {
    const start = (it.start ?? {}) as Row;
    const end = (it.end ?? {}) as Row;
    return {
      id: String(it.id ?? ""), status: String(it.status ?? ""), summary: String(it.summary ?? ""),
      timeZone: String(start.timeZone ?? ""),
      startsAt: googleTime(String(start.dateTime ?? ""), String(start.date ?? "")),
      endsAt: googleTime(String(end.dateTime ?? ""), String(end.date ?? "")),
    };
  });
  return { events, next: String(body.nextSyncToken ?? "") };
};

const revoke = async (ctx: Ctx, token: string): Promise<void> => {
  await http(ctx)("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(token), { method: "POST" });
};

// Routes.

export const googleStatus = async (ctx: Ctx): Promise<Response> => data(200, statusOf(ctx, await loadIntegration(ctx)), ctx.rid);

export const googleConnect = async (ctx: Ctx): Promise<Response> => {
  const { values } = await strictBody(ctx.request, {
    codeChallenge: { kind: "str", required: true },
    codeChallengeMethod: { kind: "str", required: true },
    redirectUri: { kind: "str", required: true },
  });
  routerCheck(ctx);
  await cipher(ctx);
  if (values.codeChallengeMethod !== "S256") throw fieldError("codeChallengeMethod", "must be S256");
  if (!values.codeChallenge) throw fieldError("codeChallenge", "required");
  const redirectUri = String(values.redirectUri);
  if (redirectUri !== APP_CALLBACK && !WEB_CALLBACK.test(redirectUri)) throw fieldError("redirectUri", "not allowed");
  const state = randomToken();
  const callbackUrl = ctx.url.origin + "/api/v1/integrations/google/callback";
  const expiresAt = addMs(ctx, STATE_TTL_MS);
  await query(ctx.deps.query,
    "INSERT INTO oauth_states (state, provider, code_challenge, redirect_uri, final_uri, expires_at, created_at, user_id, purpose) VALUES ($1,'google',$2,$3,$4,$5,$6,$7,'GOOGLE')",
    [state, values.codeChallenge, callbackUrl, redirectUri, expiresAt, ts(ctx.now), ctx.user.id]);
  const params = new URLSearchParams({
    client_id: String(ctx.env.GOOGLE_CLIENT_ID), redirect_uri: callbackUrl, response_type: "code", state,
    scope: SCOPE_GMAIL + " " + SCOPE_CALENDAR, access_type: "offline", prompt: "consent",
  });
  return data(200, { authorizationUrl: AUTH_URL + "?" + params.toString(), state, expiresAt }, ctx.rid);
};

export const googleCallback = async (ctx: Ctx): Promise<Response> => {
  routerCheck(ctx);
  const key = await cipher(ctx);
  const state = ctx.url.searchParams.get("state") || "";
  const code = ctx.url.searchParams.get("code") || "";
  const rec = await one(ctx.deps.query,
    "SELECT state, provider, code_challenge, redirect_uri, final_uri, expires_at, created_at, user_id, purpose FROM oauth_states WHERE state = $1", [state]);
  if (!rec) throw unauthenticated("invalid state");
  await query(ctx.deps.query, "DELETE FROM oauth_states WHERE state = $1", [state]);
  if (ctx.now.getTime() > Date.parse(String(ts(rec.expires_at))) || rec.purpose !== "GOOGLE" || rec.user_id == null) {
    throw unauthenticated("state expired");
  }
  const userId = String(rec.user_id);
  let tokens: Tokens;
  try {
    tokens = await tokenRequest(ctx, {
      client_id: String(ctx.env.GOOGLE_CLIENT_ID), client_secret: String(ctx.env.GOOGLE_CLIENT_SECRET),
      code, redirect_uri: String(rec.redirect_uri), grant_type: "authorization_code",
    });
  } catch {
    throw providerError("provider token exchange failed");
  }
  const payload = pyJson({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, scope: tokens.scope, expiresIn: tokens.expiresIn });
  const sealed = await seal(key, payload, userId);
  const integrationCode = randomToken();
  await query(ctx.deps.query,
    "INSERT INTO integration_codes (code, user_id, code_challenge, payload, expires_at, used_at, created_at) VALUES ($1,$2,$3,$4::jsonb,$5,NULL,$6)",
    [integrationCode, userId, rec.code_challenge, JSON.stringify({ ciphertext: sealed.ct, nonce: sealed.nonce }), addMs(ctx, CODE_TTL_MS), ts(ctx.now)]);
  const target = (rec.final_uri ? String(rec.final_uri) : APP_CALLBACK) + "?code=" + integrationCode;
  return new Response(null, { status: 302, headers: { location: target, "x-request-id": ctx.rid } });
};

export const googleComplete = async (ctx: Ctx): Promise<Response> => {
  const { values } = await strictBody(ctx.request, {
    integrationCode: { kind: "str", required: true },
    codeVerifier: { kind: "str", required: true },
  });
  routerCheck(ctx);
  const key = await cipher(ctx);
  const code = String(values.integrationCode);
  const rec = await one(ctx.deps.query,
    "SELECT code, user_id, code_challenge, payload, expires_at, used_at FROM integration_codes WHERE code = $1", [code]);
  if (!rec) throw unauthenticated("invalid code");
  if (rec.used_at != null || ctx.now.getTime() > Date.parse(String(ts(rec.expires_at)))) throw unauthenticated("code expired or already used");
  if (String(rec.user_id) !== ctx.user.id) throw unauthenticated("code belongs to a different account");
  const verifier = String(values.codeVerifier);
  if (!verifier || !(await verifyPkce(verifier, String(rec.code_challenge)))) throw unauthenticated("pkce verification failed");
  let payload: Row;
  try {
    const bundle = rec.payload as Row;
    payload = JSON.parse(await open(key, bundle.ciphertext, bundle.nonce, ctx.user.id)) as Row;
  } catch {
    throw new HttpError(500, "INTERNAL", "internal error");
  }
  const now = ts(ctx.now);
  const access = await seal(key, String(payload.accessToken), ctx.user.id);
  const gi: Row = {
    access_ciphertext: access.ct, access_nonce: access.nonce, refresh_ciphertext: null, refresh_nonce: null,
    scopes: String(payload.scope ?? "").split(/\s+/).filter(Boolean), token_expires_at: null,
    gmail_history_id: null, calendar_sync_token: null, last_synced_at: null, created_at: now, updated_at: now,
  };
  if (payload.expiresIn) gi.token_expires_at = addMs(ctx, Number(payload.expiresIn) * 1000);
  if (payload.refreshToken) {
    const refresh = await seal(key, String(payload.refreshToken), ctx.user.id);
    gi.refresh_ciphertext = refresh.ct;
    gi.refresh_nonce = refresh.nonce;
  }
  const marked = await query(ctx.deps.query, "UPDATE integration_codes SET used_at = $2 WHERE code = $1 AND used_at IS NULL", [code, now]);
  if (!marked.rowCount) throw unauthenticated("code expired or already used");
  await putIntegration(ctx, gi);
  return data(200, statusOf(ctx, await loadIntegration(ctx)), ctx.rid);
};

export const googleDisconnect = async (ctx: Ctx): Promise<Response> => {
  const gi = await loadIntegration(ctx);
  if (!gi) return noContent(ctx.rid);
  let key: CryptoKey | null = null;
  try { key = ctx.env.BYOK_MASTER_KEY ? await masterKey(ctx.env.BYOK_MASTER_KEY) : null; } catch { key = null; }
  try {
    if (!key) throw new Error("no cipher");
    await revoke(ctx, await open(key, gi.access_ciphertext, gi.access_nonce, ctx.user.id));
  } catch {
    if (key && gi.refresh_ciphertext) {
      try { await revoke(ctx, await open(key, gi.refresh_ciphertext, gi.refresh_nonce, ctx.user.id)); } catch { /* best effort, as in Python */ }
    }
  }
  await query(ctx.deps.query,
    "WITH m AS (DELETE FROM google_messages WHERE user_id = $1), e AS (DELETE FROM calendar_events WHERE user_id = $1 AND source = 'GOOGLE') DELETE FROM google_integrations WHERE user_id = $1",
    [ctx.user.id]);
  return noContent(ctx.rid);
};

const operationDto = (op: Row): Row => ({
  id: op.id, type: "GOOGLE_SYNC", applicationId: null, status: op.status, progress: null,
  result: op.result ?? null, error: op.error ?? null, inputRequest: null, createdAt: op.created_at, updatedAt: op.updated_at,
});

export const googleSync = async (ctx: Ctx): Promise<Response> => {
  routerCheck(ctx);
  const gi = await requireConnection(ctx);
  const now = ts(ctx.now);
  const op: Row = { id: crypto.randomUUID(), status: "RUNNING", created_at: now, updated_at: now };
  await query(ctx.deps.query,
    "INSERT INTO operations (id, user_id, type, application_id, status, progress, result, error, input_request, pending_payload, created_at, updated_at) VALUES ($1,$2,'GOOGLE_SYNC',NULL,'RUNNING',NULL,NULL,NULL,NULL,NULL,$3,$3) ON CONFLICT (id) DO NOTHING",
    [op.id, ctx.user.id, now]);
  const fail = async (code: string, message: string): Promise<never> => {
    try {
      await query(ctx.deps.query, "UPDATE operations SET status = 'FAILED', error = $2::jsonb, updated_at = $3 WHERE id = $1",
        [op.id, JSON.stringify({ code, message, retryable: true }), ts(ctx.now)]);
    } catch { /* the error response matters more */ }
    throw providerError(message);
  };
  let key: CryptoKey;
  let token = "";
  try {
    key = await masterKey(String(ctx.env.BYOK_MASTER_KEY || ""));
    token = await open(key, gi.access_ciphertext, gi.access_nonce, ctx.user.id);
    const expires = gi.token_expires_at == null ? null : Date.parse(String(ts(gi.token_expires_at)));
    if (expires !== null && ctx.now.getTime() > expires - 60_000 && gi.refresh_ciphertext) {
      const refresh = await open(key, gi.refresh_ciphertext, gi.refresh_nonce, ctx.user.id);
      const fresh = await tokenRequest(ctx, {
        client_id: String(ctx.env.GOOGLE_CLIENT_ID), client_secret: String(ctx.env.GOOGLE_CLIENT_SECRET),
        refresh_token: refresh, grant_type: "refresh_token",
      });
      const sealed = await seal(key, fresh.accessToken, ctx.user.id);
      gi.access_ciphertext = sealed.ct;
      gi.access_nonce = sealed.nonce;
      if (fresh.expiresIn > 0) gi.token_expires_at = addMs(ctx, fresh.expiresIn * 1000);
      await putIntegration(ctx, gi);
      token = fresh.accessToken;
    }
  } catch {
    await fail("PROVIDER_ERROR", "google access token unavailable");
  }
  const messages: MessageMeta[] = [];
  let events: GoogleEvent[] = [];
  let historyId = gi.gmail_history_id == null ? null : String(gi.gmail_history_id);
  let syncToken = gi.calendar_sync_token == null ? null : String(gi.calendar_sync_token);
  if (gmailBeta(ctx) && gi.scopes.includes(SCOPE_GMAIL)) {
    let pageToken = "";
    for (let i = 0; i < 5; i += 1) {
      let listed: { ids: string[]; next: string; history: string } = { ids: [], next: "", history: "" };
      try { listed = await listMessageIds(ctx, token, pageToken); } catch { await fail("PROVIDER_ERROR", "gmail message list failed"); }
      for (const id of listed.ids) {
        try { messages.push(await getMessage(ctx, token, id)); } catch { await fail("PROVIDER_ERROR", "gmail message fetch failed"); }
      }
      if (listed.history && listed.history !== "0") historyId = listed.history;
      if (!listed.next) break;
      pageToken = listed.next;
    }
  }
  if (gi.scopes.includes(SCOPE_CALENDAR)) {
    let listed: { events: GoogleEvent[]; next: string } = { events: [], next: "" };
    try {
      listed = await listEvents(ctx, token, syncToken ?? "");
    } catch (err) {
      if (!(err instanceof SyncTokenInvalid)) await fail("PROVIDER_ERROR", "calendar event list failed");
      try { listed = await listEvents(ctx, token, ""); } catch { await fail("PROVIDER_ERROR", "calendar event list failed"); }
    }
    events = listed.events;
    if (listed.next) syncToken = listed.next;
  }
  const result = { kind: "GOOGLE_SYNC", value: { messages: messages.length, events: events.length, lastSyncedAt: now } };
  try {
    for (const m of messages) {
      await query(ctx.deps.query,
        `INSERT INTO google_messages (${GM_COLS}) VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9) ON CONFLICT (user_id, external_id) DO UPDATE SET thread_id = $4, sender = $5, subject = $6, snippet = $7, received_at = $8`,
        [crypto.randomUUID(), ctx.user.id, m.id, m.threadId, m.sender, m.subject, m.snippet, m.receivedAt, now]);
    }
    for (const ev of events) {
      if (ev.status === "cancelled") {
        await query(ctx.deps.query, "DELETE FROM calendar_events WHERE user_id = $1 AND external_id = $2 AND source = 'GOOGLE'", [ctx.user.id, ev.id]);
        continue;
      }
      const ends = Date.parse(ev.endsAt) <= Date.parse(ev.startsAt) ? formatJsonTimestamp(new Date(Date.parse(ev.startsAt) + 3600_000)) : ev.endsAt;
      await query(ctx.deps.query,
        `INSERT INTO calendar_events (${EVENT_COLS}) VALUES ($1,$2,1,NULL,'CUSTOM',$3,$4,$5,$6,'GOOGLE',$7,'',$8,$8) ON CONFLICT (user_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET title = $3, starts_at = $4, ends_at = $5, time_zone = $6, notes = '', revision = calendar_events.revision + 1, updated_at = $8`,
        [crypto.randomUUID(), ctx.user.id, ev.summary, ev.startsAt, ends, ev.timeZone || "UTC", ev.id, now]);
    }
    await putIntegration(ctx, { ...gi, gmail_history_id: historyId, calendar_sync_token: syncToken, last_synced_at: now, updated_at: now });
    await query(ctx.deps.query, "UPDATE operations SET status = 'SUCCEEDED', result = $2::jsonb, updated_at = $3 WHERE id = $1",
      [op.id, JSON.stringify(result), now]);
  } catch {
    await fail("INTERNAL", "google sync persistence failed");
  }
  return data(202, operationDto({ ...op, status: "SUCCEEDED", result, updated_at: now }), ctx.rid);
};

const queryUuid = (ctx: Ctx, name: string): string | null => {
  const raw = ctx.url.searchParams.get(name);
  if (!raw) return null;
  const id = parseUuid(raw);
  if (!id) throw fieldError(name, "must be a UUID");
  return id;
};

const queryTime = (ctx: Ctx, name: string): string | null => {
  const raw = ctx.url.searchParams.get(name);
  return raw ? parseTimeField(raw, name) : null;
};

export const googleMessages = async (ctx: Ctx): Promise<Response> => {
  routerCheck(ctx);
  if (!gmailBeta(ctx)) throw new HttpError(403, "FEATURE_DISABLED", "gmail sync is not enabled");
  const applicationId = queryUuid(ctx, "applicationId");
  const page = pageOf(ctx.url);
  await requireConnection(ctx);
  const where = ["user_id = $1"];
  const params: unknown[] = [ctx.user.id];
  if (applicationId) {
    params.push(applicationId);
    where.push(`application_id = $${params.length}`);
  }
  return listPage(ctx.deps.query, ctx.rid, GM_COLS, "google_messages", where, params, page, messageDto);
};

export const googleEvents = async (ctx: Ctx): Promise<Response> => {
  routerCheck(ctx);
  const from = queryTime(ctx, "from");
  const to = queryTime(ctx, "to");
  const page = pageOf(ctx.url);
  await requireConnection(ctx);
  const where = ["user_id = $1"];
  const params: unknown[] = [ctx.user.id];
  for (const [value, clause] of [[from, "starts_at >="], [to, "starts_at <="]] as const) {
    if (value === null) continue;
    params.push(value);
    where.push(`${clause} $${params.length}`);
  }
  params.push("GOOGLE");
  where.push(`source = $${params.length}`);
  return listPage(ctx.deps.query, ctx.rid, EVENT_COLS, "calendar_events", where, params, page, eventDto);
};

export const googleLinkMessage = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = parseUuid(idRaw);
  const { values } = await strictBody(ctx.request, { applicationId: { kind: "uuid", required: true } });
  routerCheck(ctx);
  if (!id) throw fieldError("id", "must be a UUID");
  await requireConnection(ctx);
  const message = await one(ctx.deps.query, `SELECT ${GM_COLS} FROM google_messages WHERE id = $1 AND user_id = $2`, [id, ctx.user.id]);
  if (!message) throw notFound();
  const app = await one(ctx.deps.query, "SELECT id FROM applications WHERE id = $1 AND user_id = $2", [values.applicationId, ctx.user.id]);
  if (!app) throw notFound();
  const linked = await query(ctx.deps.query, "UPDATE google_messages SET application_id = $3 WHERE id = $1 AND user_id = $2", [id, ctx.user.id, values.applicationId]);
  if (!linked.rowCount) throw new HttpError(500, "INTERNAL", "internal error");
  return data(200, messageDto({ ...message, application_id: values.applicationId }), ctx.rid);
};

export const isGoogleCallback = (method: string, path: string): boolean =>
  method === "GET" && path === "/api/v1/integrations/google/callback";

export const dispatchIntegrations = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  const base = "/api/v1/integrations/google";
  if (path === base && method === "GET") return googleStatus(ctx);
  if (path === base && method === "DELETE") return googleDisconnect(ctx);
  if (path === base + "/connect" && method === "POST") return googleConnect(ctx);
  if (isGoogleCallback(method, path)) return googleCallback(ctx);
  if (path === base + "/complete" && method === "POST") return googleComplete(ctx);
  if (path === base + "/sync" && method === "POST") return googleSync(ctx);
  if (path === base + "/messages" && method === "GET") return googleMessages(ctx);
  if (path === base + "/events" && method === "GET") return googleEvents(ctx);
  const link = path.match(/^\/api\/v1\/integrations\/google\/messages\/([^/]+)\/link$/);
  if (link && method === "POST") return googleLinkMessage(ctx, link[1]);
  return null;
};
