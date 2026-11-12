import { boundTransaction, lockOwner } from "../billing/credits.ts";
import { isLockTimeout, one, query, type Query, type Transaction } from "../db.ts";
import { HttpError, asBool, data, fieldError, noContent, requireUuid, uuid5Url } from "../http.ts";
import { revisionUpdate, ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import { readObject, rejectFields, textOf, httpsUrl } from "./recruiting-shared.ts";
import { requireAgentConsent } from "./conversations.ts";

/** Mirrors bots_color_chk (migration 0053). */
export const BOT_COLORS = ["teal", "sky", "blue", "violet", "pink", "red", "coral", "amber", "green", "brown", "gray"] as const;
type BotColor = (typeof BOT_COLORS)[number];

const COMPANY_LIMIT: Record<string, number | null> = { FREE: 3, PRO: 20, ULTRA: null };
const PUSH_LABEL = "Push Bot";
const PUSH_ADDRESS = "push";
const DISPLAY_NAME_MAX = 120;
const UUID_IN_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const pushBotId = (userId: string): Promise<string> => uuid5Url(`push:bot:${userId}`);

const planTier = (plan: unknown): string => {
  const tier = plan == null ? "" : String(plan).trim().toUpperCase();
  return tier || "FREE";
};

const companyBotLimit = (plan: unknown): number | null => {
  const tier = planTier(plan);
  const limit = COMPANY_LIMIT[tier];
  return limit === undefined ? COMPANY_LIMIT.FREE : limit;
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

type BotRow = Record<string, unknown>;

const botDto = (row: BotRow): Record<string, unknown> => ({
  id: String(row.id),
  kind: String(row.kind),
  displayName: String(row.display_name ?? ""),
  companyId: row.company_id == null ? null : String(row.company_id),
  companyName: String(row.company_name ?? ""),
  color: String(row.kind) === "push" ? null : String(row.color),
  postingId: row.posting_id == null ? null : String(row.posting_id),
  postingUrl: row.posting_url == null ? null : String(row.posting_url),
  avatarKey: row.avatar_key == null ? null : String(row.avatar_key),
  mascotKey: row.mascot_key == null ? null : String(row.mascot_key),
  notificationsMuted: asBool(row.notifications_muted),
  revision: Number(row.revision ?? 1),
  createdAt: ts(row.created_at),
  updatedAt: ts(row.updated_at),
  lastMessagePreview: row.last_message_preview == null ? "" : String(row.last_message_preview),
  unread: row.unread === true || row.unread === "t",
  status: row.status == null ? "DONE" : String(row.status),
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

const enrichBotsSql = (): string => {
  return `WITH last_msg AS (
       SELECT DISTINCT ON (c.bot_id) c.bot_id, left(m.text, 140) AS preview
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id
       WHERE c.user_id = $1 AND c.bot_id IS NOT NULL AND NOT c.archived
       ORDER BY c.bot_id, m.created_at DESC, m.id DESC
     ),
     bot_activity AS (
       SELECT c.bot_id,
         max(c.updated_at) AS latest_at,
         bool_or(EXISTS (
           SELECT 1 FROM approvals a
           WHERE a.conversation_id = c.id AND a.status = 'PENDING'
             AND (a.expires_at IS NULL OR a.expires_at > now())
         )) AS needs_approval,
         bool_or(EXISTS (
           SELECT 1 FROM chat_jobs j
           WHERE j.conversation_id = c.id AND j.status IN ('PENDING', 'RUNNING')
         )) AS running
       FROM conversations c
       WHERE c.user_id = $1 AND c.bot_id IS NOT NULL AND NOT c.archived
       GROUP BY c.bot_id
     )
     SELECT ${BOT_COLS},
       COALESCE(lm.preview, '') AS last_message_preview,
       CASE
         WHEN ba.needs_approval THEN 'NEEDS_APPROVAL'
         WHEN ba.running THEN 'RUNNING'
         ELSE 'DONE'
       END AS status,
       (
         ba.latest_at IS NOT NULL AND (
           br.read_at IS NULL OR ba.latest_at > br.read_at
         )
       ) AS unread
     FROM bots b
     LEFT JOIN last_msg lm ON lm.bot_id = b.id
     LEFT JOIN bot_activity ba ON ba.bot_id = b.id
     LEFT JOIN bot_read_markers br ON br.user_id = b.user_id AND br.bot_id = b.id
     WHERE b.user_id = $1 AND b.deleted_at IS NULL`;
};

const readBot = async (ctx: Ctx, id: string): Promise<Record<string, unknown>> => {
  const row = await one(ctx.deps.query, enrichBotsSql() + " AND b.id = $2", [ctx.user.id, id]);
  if (!row) throw notFound();
  return botDto(row);
};

const listBots = async (ctx: Ctx): Promise<Response> => {
  await ensurePushBot(ctx);
  const rows = await query(ctx.deps.query,
    enrichBotsSql() + " ORDER BY CASE WHEN b.kind = 'push' THEN 0 ELSE 1 END, b.updated_at DESC, b.id DESC",
    [ctx.user.id]);
  const items = rows.rows.map(botDto);
  return data(200, items, ctx.rid);
};

const inTransactionOf = (ctx: Ctx): Transaction =>
  ctx.deps.transaction ?? ((work) => work(ctx.deps.query));

const companyBotId = async (q: Query, userId: string, company: string): Promise<string | null> => {
  const row = await one(q,
    "SELECT id FROM bots WHERE user_id = $1 AND kind = 'company' AND deleted_at IS NULL AND company_key = bot_company_key($2)",
    [userId, company]);
  return row ? String(row.id) : null;
};

const createBot = async (ctx: Ctx): Promise<Response> => {
  const body = await readObject(ctx.request);
  closedBody(body, ["postingId", "displayName", "color"]);
  const postingId = requireUuid(String(body.postingId ?? ""), "postingId");
  const displayName = body.displayName == null ? null : textOf(body.displayName, "displayName", 1, DISPLAY_NAME_MAX);
  const color = body.color == null ? "teal" : colorOf(body.color);
  await requireAgentConsent(ctx);
  const limit = companyBotLimit(ctx.user.plan);
  try {
    const made = await inTransactionOf(ctx)(async (q) => {
      const posting = await one(q, "SELECT company FROM job_postings WHERE id = $1 AND status <> 'DRAFT'", [postingId]);
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
          throw new HttpError(403, "BOT_LIMIT", "company bot limit reached for your plan", { limit, plan: planTier(ctx.user.plan) });
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
  return data(200, await readBot(ctx, String(bot.id)), ctx.rid);
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
  const displayName = body.displayName == null ? String(current.display_name ?? "") : textOf(body.displayName, "displayName", 1, DISPLAY_NAME_MAX);
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
  if (byId) {
    const posting = await one(ctx.deps.query, "SELECT id, company, title FROM job_postings WHERE id = $1", [byId]);
    if (posting) {
      return data(200, {
        status: "found",
        company: String(posting.company ?? ""),
        title: String(posting.title ?? ""),
        postingId: String(posting.id),
      }, ctx.rid);
    }
  }
  const canon = canonUrl(url);
  const row = await one(ctx.deps.query,
    `SELECT id, company, title FROM job_postings
     WHERE source_url IS NOT NULL AND (
       source_url = $1 OR source_url = $2 OR rtrim(source_url, '/') = rtrim($1, '/')
     )
     ORDER BY created_at DESC LIMIT 1`,
    [url, canon]);
  if (row) {
    return data(200, {
      status: "found",
      company: String(row.company ?? ""),
      title: String(row.title ?? ""),
      postingId: String(row.id),
    }, ctx.rid);
  }
  return data(200, { status: "not_a_posting" }, ctx.rid);
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
