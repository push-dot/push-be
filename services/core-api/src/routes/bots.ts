import { boundTransaction, lockOwner } from "../billing/credits.ts";
import { isLockTimeout, one, query, type Query, type Transaction } from "../db.ts";
import { HttpError, asBool, data, fieldError, jsonResponse, noContent, requireUuid, uuid5Url } from "../http.ts";
import { pageOf, pageResult, revisionUpdate, ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import { readObject, rejectFields, textOf, httpsUrl } from "./recruiting-shared.ts";
import { requireAgentConsent } from "./conversations.ts";

/** Mirrors bots_color_chk (migration 0053). */
export const BOT_COLORS = ["teal", "sky", "blue", "violet", "pink", "red", "coral", "amber", "green", "brown", "gray"] as const;
type BotColor = (typeof BOT_COLORS)[number];

/** Company bots a personal plan allows. null is unlimited. The Push Bot is not counted. */
const COMPANY_LIMIT = { FREE: 3, PRO: 20, ULTRA: null } as const;
type Plan = keyof typeof COMPANY_LIMIT;

const PUSH_LABEL = "Push Bot";
const PUSH_ADDRESS = "push";
const DISPLAY_NAME_MAX = 120;
const SEARCH_Q_MAX = 200;
const SEARCH_LIMIT = { default: 20, max: 50 };
const SNIPPET = { before: 30, after: 60 };
const UUID_IN_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const pushBotId = (userId: string): Promise<string> => uuid5Url(`push:bot:${userId}`);

/** A plan the table does not name gets the FREE limit, and is reported as FREE. */
const planOf = (plan: unknown): Plan => {
  const tier = String(plan ?? "").trim().toUpperCase();
  return tier in COMPANY_LIMIT ? tier as Plan : "FREE";
};

const canonUrl = (value: string): string => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return `${url.protocol}//${host}${path}${url.search}`;
  } catch {
    return value.trim();
  }
};

const postingIdFromUrl = (url: string): string | null => {
  const match = url.match(UUID_IN_PATH);
  if (!match) return null;
  try {
    return requireUuid(match[0], "url");
  } catch {
    return null;
  }
};

const notFound = (): HttpError => new HttpError(404, "NOT_FOUND", "resource not found");

const closedBody = (body: Record<string, unknown>, allowed: string[]): void => {
  const extra = Object.keys(body).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw fieldError(extra, "unknown field");
};

const colorOf = (value: unknown): BotColor => {
  const color = BOT_COLORS.find((name) => name === value);
  if (!color) throw fieldError("color", `must be one of ${BOT_COLORS.join(", ")}`);
  return color;
};

const nameOf = (value: unknown): string => {
  const name = textOf(value, "displayName", 1, DISPLAY_NAME_MAX).trim();
  if (!name) throw fieldError("displayName", "must not be blank");
  return name;
};

const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

// ILIKE folds case through the database's locale, which is most of a search's time. Under the C
// collation it folds A to Z only, and that is all a q needs unless it holds a cased letter outside ASCII.
const foldOf = (q: string): string =>
  ([...q].some((ch) => ch > "\x7f" && ch.toLowerCase() !== ch.toUpperCase()) ? "" : ' COLLATE "C"');

export const snippetOf = (text: string, q: string): string => {
  const found = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu").exec(text);
  const chars = [...text];
  const at = found ? [...text.slice(0, found.index)].length : 0;
  const start = Math.max(0, at - SNIPPET.before);
  const end = at + (found ? [...found[0]].length : 0) + SNIPPET.after;
  return (start > 0 ? "…" : "") + chars.slice(start, end).join("");
};

type BotRow = Record<string, unknown>;

const textOrNull = (value: unknown): string | null => (value == null ? null : String(value));

/** Columns bot_id, kind, display_name and color of any row to the BotRef of the contract. */
const botRef = (row: BotRow): Record<string, unknown> => ({
  id: String(row.bot_id),
  kind: String(row.kind),
  displayName: String(row.display_name ?? ""),
  color: String(row.kind) === "push" ? null : String(row.color),
});

// An open card comes before a run: the run that asked it has ended, and the next one starts with the answer.
const activityOf = (row: BotRow): Record<string, unknown> | null => {
  if (row.card_id != null) {
    return {
      phase: "waiting", since: ts(row.card_at), for: String(row.card_for), cardId: String(row.card_id),
      cardTitle: String(row.card_title ?? ""), expiresAt: ts(row.card_expires_at),
    };
  }
  const since = ts(row.job_at);
  switch (row.job_phase) {
    case "queued": return { phase: "queued", since, ahead: Number(row.job_ahead ?? 0) };
    case "working": return { phase: "working", since, label: String(row.job_text ?? "") };
    case "thinking": return { phase: "thinking", since, label: textOrNull(row.job_recent_text) };
    default: return null;
  }
};

const botDto = (row: BotRow): Record<string, unknown> => {
  const activity = activityOf(row);
  const lastMessage = row.last_message_at == null ? null : {
    preview: String(row.last_message_preview ?? ""), at: ts(row.last_message_at), fromBot: asBool(row.last_message_from_bot),
  };
  return {
    ...botRef(row),
    companyName: String(row.company_name ?? ""),
    postingId: textOrNull(row.posting_id),
    notificationsMuted: asBool(row.notifications_muted),
    revision: Number(row.revision ?? 1),
    createdAt: ts(row.created_at),
    lastActivityAt: ts(row.last_activity_at),
    lastMessage,
    unread: asBool(row.unread),
    activity,
    // The app build from before the bot contract reads the fields below. They go with migration 0058.
    companyId: null,
    postingUrl: textOrNull(row.posting_url),
    avatarKey: textOrNull(row.avatar_key),
    mascotKey: textOrNull(row.mascot_key),
    updatedAt: ts(row.updated_at),
    lastMessagePreview: lastMessage?.preview ?? "",
    status: activity == null ? "DONE" : activity.phase === "waiting" ? "NEEDS_APPROVAL" : "RUNNING",
  };
};

const botDetailDto = (row: BotRow): Record<string, unknown> => ({
  ...botDto(row),
  posting: row.posting_title == null ? null : {
    id: String(row.posting_id), title: String(row.posting_title), deadline: textOrNull(row.posting_deadline), closed: asBool(row.posting_closed),
  },
  fit: row.fit_score == null ? null : { score: Number(row.fit_score) },
});

const BOT_COLS = "b.id, b.kind, b.company_id, b.company_name, b.color, b.posting_id, b.posting_url, b.display_name, b.avatar_key, b.mascot_key, b.notifications_muted, b.revision, b.created_at, b.updated_at";

// No conflict target: two first requests at once collide on the one-Push-Bot-per-user index as well as on the id.
const ensurePushBot = async (ctx: Ctx): Promise<string> => {
  const id = await pushBotId(ctx.user.id);
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    `INSERT INTO bots (id, user_id, kind, company_name, display_name, created_at, updated_at)
     VALUES ($1,$2,'push','', $3,$4,$4)
     ON CONFLICT DO NOTHING`,
    [id, ctx.user.id, PUSH_LABEL, now]);
  return id;
};

/**
 * `{id}` of a /bots/{id} route to a live bot the caller owns, or 404. `push` is the caller's Push Bot,
 * which is inserted when missing, so every route works before the first GET /bots.
 */
export const resolveBot = async (ctx: Ctx, raw: string): Promise<BotRow> => {
  const pushId = await pushBotId(ctx.user.id);
  const id = raw === PUSH_ADDRESS ? pushId : requireUuid(raw, "id");
  if (id === pushId) await ensurePushBot(ctx);
  const row = await one(ctx.deps.query,
    `SELECT ${BOT_COLS} FROM bots b WHERE b.id = $1 AND b.user_id = $2 AND b.deleted_at IS NULL`,
    [id, ctx.user.id]);
  if (!row) throw notFound();
  return row;
};

// Every bot read is bot_state_v filtered on its own user_id. The filter then reaches the scan of bots
// inside the view, and only the caller's bots are evaluated.
const BOT_SELECT = "SELECT s.* FROM bot_state_v s WHERE s.user_id = $1";
const BOT_POSTING_SELECT = `SELECT s.*, p.title AS posting_title, p.deadline::text AS posting_deadline, (p.closed_at IS NOT NULL) AS posting_closed,
    (SELECT f.fit_score FROM posting_fit_cache f WHERE f.user_id = s.user_id AND f.posting_id = s.posting_id
     ORDER BY f.created_at DESC LIMIT 1) AS fit_score
  FROM bot_state_v s LEFT JOIN job_postings p ON p.id = s.posting_id WHERE s.user_id = $1`;
const BOT_ORDER = " ORDER BY (s.kind = 'push') DESC, s.last_activity_at DESC, s.bot_id DESC";

const readBot = async (ctx: Ctx, id: string): Promise<Record<string, unknown>> => {
  const row = await one(ctx.deps.query, BOT_SELECT + " AND s.bot_id = $2", [ctx.user.id, id]);
  if (!row) throw notFound();
  return botDto(row);
};

const POSTING_SELECT = "SELECT p.id, p.company, p.title, p.deadline::text AS deadline, p.career_min, p.career_max, p.location FROM job_postings p WHERE p.status <> 'DRAFT'";

/** A posting a company bot can be made from: not a draft, and its company is not blank. `company` comes back trimmed. */
const botPosting = async (q: Query, where: string, params: unknown[]): Promise<BotRow | null> => {
  const row = await one(q, `${POSTING_SELECT} AND ${where}`, params);
  const company = String(row?.company ?? "").trim();
  return row && company ? { ...row, company } : null;
};

const companyBotId = async (q: Query, userId: string, company: string): Promise<string | null> => {
  const row = await one(q,
    "SELECT id FROM bots WHERE user_id = $1 AND kind = 'company' AND deleted_at IS NULL AND company_key = bot_company_key($2)",
    [userId, company]);
  return row ? String(row.id) : null;
};

const listBots = async (ctx: Ctx): Promise<Response> => {
  const q = ctx.deps.query;
  const postingId = ctx.url.searchParams.get("postingId");
  if (postingId != null) {
    const posting = await botPosting(q, "p.id = $1", [requireUuid(postingId, "postingId")]);
    const id = posting && await companyBotId(q, ctx.user.id, String(posting.company));
    const found = id ? (await query(q, BOT_SELECT + " AND s.bot_id = $2", [ctx.user.id, id])).rows : [];
    return jsonResponse(200, { data: found.map(botDto) }, ctx.rid);
  }
  await ensurePushBot(ctx);
  const rows = (await query(q, BOT_SELECT + BOT_ORDER, [ctx.user.id])).rows;
  const plan = planOf(ctx.user.plan);
  const limit = { plan, max: COMPANY_LIMIT[plan], used: rows.filter((row) => row.kind === "company").length, table: COMPANY_LIMIT };
  return jsonResponse(200, { data: rows.map(botDto), limit }, ctx.rid);
};

const inTransactionOf = (ctx: Ctx): Transaction =>
  ctx.deps.transaction ?? ((work) => work(ctx.deps.query));

const createBot = async (ctx: Ctx): Promise<Response> => {
  const body = await readObject(ctx.request);
  closedBody(body, ["postingId", "displayName", "color"]);
  const postingId = requireUuid(String(body.postingId ?? ""), "postingId");
  const displayName = body.displayName == null ? null : nameOf(body.displayName);
  const color = body.color == null ? "teal" : colorOf(body.color);
  await requireAgentConsent(ctx);
  const plan = planOf(ctx.user.plan);
  const limit = COMPANY_LIMIT[plan];
  try {
    const made = await inTransactionOf(ctx)(async (q) => {
      const posting = await botPosting(q, "p.id = $1", [postingId]);
      if (!posting) throw notFound();
      const company = String(posting.company);
      if (limit != null) {
        await boundTransaction(q, "3s");
        await lockOwner(q, "PERSONAL", ctx.user.id);
      }
      const existing = await companyBotId(q, ctx.user.id, company);
      if (existing) return { id: existing, created: false };
      if (limit != null) {
        const row = await one(q, "SELECT count(*)::int AS n FROM bots WHERE user_id = $1 AND kind = 'company' AND deleted_at IS NULL", [ctx.user.id]);
        if (Number(row?.n ?? 0) >= limit) {
          throw new HttpError(403, "BOT_LIMIT", "company bot limit reached for your plan", { limit, plan });
        }
      }
      const inserted = await one(q,
        `INSERT INTO bots (id, user_id, kind, company_name, posting_id, display_name, color, created_at, updated_at)
         VALUES ($1,$2,'company',$3,$4,$5,$6,$7,$7)
         ON CONFLICT (user_id, company_key) WHERE kind = 'company' AND deleted_at IS NULL DO NOTHING
         RETURNING id`,
        [crypto.randomUUID(), ctx.user.id, company, postingId, displayName ?? [...company].slice(0, DISPLAY_NAME_MAX).join(""), color, ctx.now.toISOString()]);
      if (inserted) return { id: String(inserted.id), created: true };
      // ULTRA takes no lock, so a parallel create for the same company can win the unique index.
      const winner = await companyBotId(q, ctx.user.id, company);
      if (!winner) throw new HttpError(409, "CONFLICT", "the bot for this company changed, retry");
      return { id: winner, created: false };
    });
    return data(made.created ? 201 : 200, await readBot(ctx, made.id), ctx.rid);
  } catch (err) {
    if (isLockTimeout(err)) {
      throw new HttpError(429, "RATE_LIMITED", "too many requests", { retryAfterSec: 1 });
    }
    throw err;
  }
};

const getBot = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const bot = await resolveBot(ctx, idRaw);
  const row = await one(ctx.deps.query, BOT_POSTING_SELECT + " AND s.bot_id = $2", [ctx.user.id, String(bot.id)]);
  if (!row) throw notFound();
  return data(200, botDetailDto(row), ctx.rid);
};

// shortcut: a scan of every message of the caller's bot chats, add a pg_trgm index on messages.text when one user holds about 50,000 messages.
const messageSearch = (fold: string): string => `WITH hits AS MATERIALIZED (
    SELECT m.id, m.created_at, b.id AS bot_id
    FROM bots b
    JOIN conversations c ON c.bot_id = b.id
    JOIN messages m ON m.conversation_id = c.id
    WHERE b.user_id = $1 AND b.deleted_at IS NULL AND m.text${fold} ILIKE $2 ESCAPE '\\'
  ), page AS (
    SELECT h.id, h.bot_id FROM hits h
    WHERE $3::timestamptz IS NULL OR (h.created_at, h.id) < ($3::timestamptz, $4::uuid)
    ORDER BY h.created_at DESC, h.id DESC LIMIT $5
  )
  SELECT t.total, m.id, m.created_at, m.role, m.text, b.id AS bot_id, b.kind, b.display_name, b.color
  FROM (SELECT count(*)::int AS total FROM hits) t
  LEFT JOIN (page JOIN messages m ON m.id = page.id JOIN bots b ON b.id = page.bot_id) ON true
  ORDER BY m.created_at DESC, m.id DESC`;

const searchBots = async (ctx: Ctx): Promise<Response> => {
  const q = (ctx.url.searchParams.get("q") ?? "").trim();
  if (!q || [...q].length > SEARCH_Q_MAX) throw fieldError("q", `q must be 1-${SEARCH_Q_MAX} characters`);
  const page = pageOf(ctx.url);
  const limit = ctx.url.searchParams.has("limit") ? Math.min(page.limit, SEARCH_LIMIT.max) : SEARCH_LIMIT.default;
  const pattern = likePattern(q);
  const fold = foldOf(q);
  const [named, said] = await Promise.all([
    query(ctx.deps.query,
      `${BOT_POSTING_SELECT} AND (s.display_name${fold} ILIKE $2 ESCAPE '\\' OR s.company_name${fold} ILIKE $2 ESCAPE '\\' OR p.title${fold} ILIKE $2 ESCAPE '\\')${BOT_ORDER}`,
      [ctx.user.id, pattern]),
    query(ctx.deps.query, messageSearch(fold), [ctx.user.id, pattern, page.cursor?.createdAt ?? null, page.cursor?.id ?? null, limit + 1]),
  ]);
  const bots = named.rows.map((row) => ({
    ...botDto(row),
    line: row.posting_title == null ? String(row.display_name ?? "") : `${row.company_name} · ${row.posting_title}`,
  }));
  const hits = pageResult(said.rows.filter((row) => row.id != null), limit, (row) => ({ createdAt: row.created_at, id: String(row.id) }));
  const messages = hits.items.map((row) => ({
    bot: botRef(row), messageId: String(row.id), at: ts(row.created_at), role: String(row.role), snippet: snippetOf(String(row.text ?? ""), q),
  }));
  return jsonResponse(200, {
    data: { bots, botTotal: bots.length, messages, messageTotal: Number(said.rows[0]?.total ?? 0) },
    page: { nextCursor: hits.nextCursor, hasMore: hits.hasMore },
  }, ctx.rid);
};

const PUSH_BOT_FIXED = ["displayName", "color"];

const patchBot = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const body = await readObject(ctx.request);
  closedBody(body, ["expectedRevision", "displayName", "notificationsMuted", "color"]);
  if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision)) {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
  const current = await resolveBot(ctx, idRaw);
  const id = String(current.id);
  if (String(current.kind) === "push") {
    const fixed = PUSH_BOT_FIXED.find((field) => body[field] != null);
    if (fixed) throw fieldError(fixed, "cannot be changed on the Push Bot");
  }
  if (Number(current.revision) !== body.expectedRevision) {
    throw new HttpError(409, "REVISION_CONFLICT", "resource was modified", { currentRevision: Number(current.revision) });
  }
  const displayName = body.displayName == null ? String(current.display_name ?? "") : nameOf(body.displayName);
  let notificationsMuted = asBool(current.notifications_muted);
  if (body.notificationsMuted != null) {
    if (typeof body.notificationsMuted !== "boolean") throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
    notificationsMuted = body.notificationsMuted;
  }
  const color = body.color == null ? String(current.color) : colorOf(body.color);
  await revisionUpdate(ctx.deps.query, "bots",
    `UPDATE bots SET revision = revision + 1, display_name = $3, notifications_muted = $4, color = $5, updated_at = $6
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND revision = $7
     RETURNING id`,
    [id, ctx.user.id, displayName, notificationsMuted, color, ctx.now.toISOString(), body.expectedRevision],
    id, ctx.user.id);
  return data(200, await readBot(ctx, id), ctx.rid);
};

// The thread and everything in it hang off the bot row by cascading foreign keys (migration 0053),
// so the erase names no table and also takes a thread that a first send commits meanwhile.
const deleteBot = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const bot = await resolveBot(ctx, idRaw);
  if (String(bot.kind) === "push") {
    throw new HttpError(403, "DEFAULT_BOT_PROTECTED", "default bot cannot be deleted");
  }
  const gone = await one(ctx.deps.query,
    "DELETE FROM bots WHERE id = $1 AND user_id = $2 AND kind = 'company' RETURNING id",
    [String(bot.id), ctx.user.id]);
  if (!gone) throw notFound();
  return noContent(ctx.rid);
};

const clearBotChat = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const bot = await resolveBot(ctx, idRaw);
  await query(ctx.deps.query, "DELETE FROM conversations WHERE bot_id = $1 AND user_id = $2", [String(bot.id), ctx.user.id]);
  return noContent(ctx.rid);
};

const linkPreview = async (ctx: Ctx): Promise<Response> => {
  const body = await readObject(ctx.request);
  rejectFields(body, ["status"]);
  const url = textOf(body.url, "url", 1, 2000);
  if (!httpsUrl(url)) throw fieldError("url", "must be an http(s) URL without credentials");
  const byId = postingIdFromUrl(url);
  const posting = (byId && await botPosting(ctx.deps.query, "p.id = $1", [byId]))
    ?? await botPosting(ctx.deps.query,
      `p.source_url IS NOT NULL AND (p.source_url = $1 OR p.source_url = $2 OR rtrim(p.source_url, '/') = rtrim($1, '/'))
       ORDER BY p.created_at DESC LIMIT 1`,
      [url, canonUrl(url)]);
  if (!posting) return data(200, { status: "not_a_posting" }, ctx.rid);
  return data(200, {
    status: "found",
    postingId: String(posting.id),
    company: String(posting.company),
    title: String(posting.title ?? ""),
    deadline: textOrNull(posting.deadline),
    careerMin: Number(posting.career_min ?? 0),
    careerMax: posting.career_max == null ? null : Number(posting.career_max),
    location: String(posting.location ?? "").trim() || null,
    host: new URL(url).hostname,
  }, ctx.rid);
};

const markBotRead = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const bot = await resolveBot(ctx, idRaw);
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    `INSERT INTO bot_read_markers (user_id, bot_id, read_at) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, bot_id) DO UPDATE SET read_at = EXCLUDED.read_at`,
    [ctx.user.id, String(bot.id), now]);
  return data(200, { readAt: now }, ctx.rid);
};

export const dispatchBots = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (method === "GET" && path === "/api/v1/bots") return listBots(ctx);
  if (method === "POST" && path === "/api/v1/bots") return createBot(ctx);
  if (method === "POST" && path === "/api/v1/bots/link-preview") return linkPreview(ctx);
  if (method === "GET" && path === "/api/v1/bots/search") return searchBots(ctx);
  const oneBot = path.match(/^\/api\/v1\/bots\/([^/]+)$/);
  if (method === "GET" && oneBot) return getBot(ctx, oneBot[1]);
  if (method === "PATCH" && oneBot) return patchBot(ctx, oneBot[1]);
  if (method === "DELETE" && oneBot) return deleteBot(ctx, oneBot[1]);
  const read = path.match(/^\/api\/v1\/bots\/([^/]+)\/read$/);
  if (method === "POST" && read) return markBotRead(ctx, read[1]);
  const transcript = path.match(/^\/api\/v1\/bots\/([^/]+)\/transcript$/);
  if (method === "DELETE" && transcript) return clearBotChat(ctx, transcript[1]);
  return null;
};
