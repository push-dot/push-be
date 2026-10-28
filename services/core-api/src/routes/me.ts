import { isUndefinedColumn, one, query } from "../db.ts";
import { asBool, data, fieldError, noContent, pageBody, requireUuid } from "../http.ts";
import { pageOf, pageResult, ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import {
  unprocessable,
  notFound,
  readObject,
  rejectFields,
  textOf,
  intOf,
  boolOf,
  httpsUrl,
  jsonObject,
  postingDto,
  POSTING_COLS,
  openClause,
  withPublicStatus,
  countWhere,
} from "./recruiting-shared.ts";

const LINK_KINDS = new Set(["job", "github", "portfolio", "blog", "other"]);

const TONES = new Set(["as_is", "professional", "confident", "concise", "technical", "friendly"]);

const VISIBILITY = new Set(["everyone", "followers", "private"]);

const CONTACT = new Set(["accepted", "followers", "everyone", "private"]);

const EFFORT = new Set(["LOW", "MEDIUM", "HIGH", "MAX"]);

const AI_ACCESS_MODES = new Set(["ALWAYS_ASK", "AUTO", "BYPASS"]);

function inferKind(url: string): string {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return "other"; }
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (/(^|\.)((velog\.io)|(tistory\.com)|(medium\.com)|(blogspot\.com)|(brunch\.co\.kr))$/.test(host)) return "blog";
  if (/(^|\.)((notion\.site)|(notion\.so)|(behance\.net)|(dribbble\.com))$/.test(host)) return "portfolio";
  return "other";
}

function linkDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    kind: String(row.kind ?? "other"),
    url: String(row.url ?? ""),
    title: String(row.title ?? ""),
    status: String(row.status ?? "READ"),
    fitCount: Number(row.fit_count ?? 0),
    aiRead: asBool(row.ai_read),
    createdAt: ts(row.created_at),
  };
}

async function listLinks(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const kind = ctx.url.searchParams.get("kind");
  if (kind && !LINK_KINDS.has(kind)) throw unprocessable("kind", "unsupported kind");
  const params: unknown[] = [ctx.user.id];
  let sql = "SELECT id, kind, url, title, status, fit_count, ai_read, created_at FROM user_links WHERE user_id = $1";
  if (kind) {
    params.push(kind);
    sql += ` AND kind = $${params.length}`;
  }
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (created_at, id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: linkDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

async function createLink(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  rejectFields(body, ["userId", "createdAt", "id", "status", "fitCount"]);
  const url = textOf(body.url, "url", 1, 2000);
  if (!httpsUrl(url)) throw fieldError("url", "must be an http(s) URL without credentials");
  let kind = body.kind == null || body.kind === "" ? inferKind(url) : String(body.kind);
  if (!LINK_KINDS.has(kind)) throw unprocessable("kind", "unsupported kind");
  const title = textOf(body.title ?? "", "title", 0, 300);
  const aiRead = body.aiRead == null ? false : boolOf(body.aiRead, "aiRead");
  const id = crypto.randomUUID();
  const now = ctx.now.toISOString();
  const status = "READ";
  await query(ctx.deps.query,
    "INSERT INTO user_links (id, user_id, kind, url, title, status, fit_count, ai_read, created_at) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8)",
    [id, ctx.user.id, kind, url, title, status, aiRead, now]);
  return data(201, linkDto({ id, kind, url, title, status, fit_count: 0, ai_read: aiRead, created_at: now }), ctx.rid);
}

async function deleteLink(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const row = await one(ctx.deps.query, "DELETE FROM user_links WHERE id = $1 AND user_id = $2 RETURNING id", [id, ctx.user.id]);
  if (!row) throw notFound();
  return noContent(ctx.rid);
}

const updateLink = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const body = await readObject(ctx.request);
  rejectFields(body, ["userId", "createdAt", "id", "status", "fitCount"]);
  const url = "url" in body ? textOf(body.url, "url", 1, 2000) : null;
  if (url != null && !httpsUrl(url)) throw fieldError("url", "must be an http(s) URL without credentials");
  const kind = "kind" in body ? String(body.kind) : null;
  if (kind != null && !LINK_KINDS.has(kind)) throw unprocessable("kind", "unsupported kind");
  const title = "title" in body ? textOf(body.title ?? "", "title", 0, 300) : null;
  const aiRead = "aiRead" in body ? boolOf(body.aiRead, "aiRead") : null;
  const row = await one(ctx.deps.query,
    `UPDATE user_links SET title = COALESCE($3, title), kind = COALESCE($4, kind), url = COALESCE($5, url), ai_read = COALESCE($6, ai_read) WHERE id = $1 AND user_id = $2 RETURNING id, kind, url, title, status, fit_count, ai_read, created_at`,
    [id, ctx.user.id, title, kind, url, aiRead]);
  if (!row) throw notFound();
  return data(200, linkDto(row), ctx.rid);
};

async function registerDevice(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  const token = textOf(body.token, "token", 1, 4096);
  if (body.platform !== "ios" && body.platform !== "android") throw unprocessable("platform", "unsupported platform");
  // A push token belongs to one device; after an account switch the old account must stop receiving its pushes.
  await query(ctx.deps.query,
    `WITH moved AS (DELETE FROM user_devices WHERE token = $2 AND user_id <> $1)
     INSERT INTO user_devices (user_id, token, platform, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, token) DO UPDATE SET platform = EXCLUDED.platform`,
    [ctx.user.id, token, body.platform, ctx.now.toISOString()]);
  return data(201, { token, platform: body.platform }, ctx.rid);
}

async function deleteDevice(ctx: Ctx, tokenRaw: string): Promise<Response> {
  let token: string;
  try { token = decodeURIComponent(tokenRaw); } catch { throw fieldError("token", "invalid device token"); }
  await query(ctx.deps.query, "DELETE FROM user_devices WHERE user_id = $1 AND token = $2", [ctx.user.id, token]);
  return noContent(ctx.rid);
}

function notificationDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    type: String(row.type ?? ""),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    target: jsonObject(row.target),
    readAt: ts(row.read_at),
    createdAt: ts(row.created_at),
  };
}

const unreadNotifications = async (ctx: Ctx): Promise<Response> => {
  const row = await one(ctx.deps.query,
    "SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
    [ctx.user.id]);
  return data(200, { count: Number(row?.count ?? 0) }, ctx.rid);
};

async function listNotifications(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  let sql = "SELECT id, type, title, body, target, read_at, created_at FROM notifications WHERE user_id = $1";
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (created_at, id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: notificationDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

async function readNotifications(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  const now = ctx.now.toISOString();
  if (body.all === true) {
    await query(ctx.deps.query, "UPDATE notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL", [ctx.user.id, now]);
    return noContent(ctx.rid);
  }
  if (!Array.isArray(body.ids)) throw fieldError("ids", "must be an array");
  const ids = body.ids.map((id) => requireUuid(String(id), "ids"));
  if (ids.length) {
    await query(ctx.deps.query,
      "UPDATE notifications SET read_at = $3 WHERE user_id = $1 AND id = ANY(string_to_array($2, E'\\x1f')::uuid[]) AND read_at IS NULL",
      [ctx.user.id, ids.join("\u001f"), now]);
  }
  return noContent(ctx.rid);
}

function settingsDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    notifyDeadline: asBool(row.notify_deadline),
    notifyOffer: asBool(row.notify_offer),
    notifyComment: asBool(row.notify_comment),
    notifyAiDone: asBool(row.notify_ai_done),
    notifyApplicationStage: row.notify_application_stage == null ? true : asBool(row.notify_application_stage),
    locale: String(row.locale ?? "ko"),
    profilePublic: asBool(row.profile_public),
    careerStatusVisibility: String(row.career_status_visibility ?? "everyone"),
    hideFromCurrentCompany: asBool(row.hide_from_current_company),
    contactVisibility: String(row.contact_visibility ?? "accepted"),
    defaultTone: String(row.default_tone ?? "as_is"),
    chatRetentionDays: row.chat_retention_days == null ? null : Number(row.chat_retention_days),
    allowAiReadMyFiles: asBool(row.allow_ai_read_my_files),
    defaultEffort: row.default_effort == null || row.default_effort === "" ? "MEDIUM" : String(row.default_effort),
    confirmBeforeEdit: row.confirm_before_edit == null ? true : asBool(row.confirm_before_edit),
    aiAccessMode: row.ai_access_mode == null || row.ai_access_mode === "" ? "AUTO" : String(row.ai_access_mode),
  };
}

const SETTINGS_SELECT = `SELECT s.notify_deadline, s.notify_offer, s.notify_comment, s.notify_ai_done, s.notify_application_stage, u.locale, s.profile_public,
            s.career_status_visibility, s.hide_from_current_company, s.contact_visibility, s.default_tone,
            s.chat_retention_days, s.allow_ai_read_my_files,
            to_jsonb(s) ->> 'default_effort' AS default_effort, to_jsonb(s) ->> 'confirm_before_edit' AS confirm_before_edit,
            to_jsonb(s) ->> 'ai_access_mode' AS ai_access_mode
     FROM user_settings s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1`;

const SETTINGS_UPDATE = `UPDATE user_settings SET notify_deadline = $2, notify_offer = $3, notify_comment = $4, notify_ai_done = $5,
      profile_public = $6, career_status_visibility = $7, hide_from_current_company = $8, contact_visibility = $9,
      default_tone = $10, chat_retention_days = $11, allow_ai_read_my_files = $12, notify_application_stage = $13, updated_at = $14 WHERE user_id = $1`;

const SETTINGS_UPDATE_MODE = `UPDATE user_settings SET notify_deadline = $2, notify_offer = $3, notify_comment = $4, notify_ai_done = $5,
      profile_public = $6, career_status_visibility = $7, hide_from_current_company = $8, contact_visibility = $9,
      default_tone = $10, chat_retention_days = $11, allow_ai_read_my_files = $12, notify_application_stage = $13, updated_at = $14,
      default_effort = $15, confirm_before_edit = $16, ai_access_mode = $17 WHERE user_id = $1`;

const SETTINGS_UPDATE_EFFORT = `UPDATE user_settings SET notify_deadline = $2, notify_offer = $3, notify_comment = $4, notify_ai_done = $5,
      profile_public = $6, career_status_visibility = $7, hide_from_current_company = $8, contact_visibility = $9,
      default_tone = $10, chat_retention_days = $11, allow_ai_read_my_files = $12, notify_application_stage = $13, updated_at = $14,
      default_effort = $15, confirm_before_edit = $16 WHERE user_id = $1`;

const SETTINGS_UPDATE_LEGACY = `UPDATE user_settings SET notify_deadline = $2, notify_offer = $3, notify_comment = $4, notify_ai_done = $5,
      profile_public = $6, career_status_visibility = $7, hide_from_current_company = $8, contact_visibility = $9,
      default_tone = $10, chat_retention_days = $11, allow_ai_read_my_files = $12, updated_at = $13 WHERE user_id = $1`;

async function loadSettings(ctx: Ctx): Promise<Record<string, unknown>> {
  await query(ctx.deps.query, "INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [ctx.user.id]);
  try {
    const row = await one(ctx.deps.query, SETTINGS_SELECT, [ctx.user.id]);
    if (!row) throw notFound();
    return row;
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    const row = await one(ctx.deps.query, SETTINGS_SELECT.replace("s.notify_application_stage, ", ""), [ctx.user.id]);
    if (!row) throw notFound();
    return row;
  }
}

async function getSettings(ctx: Ctx): Promise<Response> {
  return data(200, settingsDto(await loadSettings(ctx)), ctx.rid);
}

async function patchSettings(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  const current = await loadSettings(ctx);
  const next = { ...current };
  if ("notifyDeadline" in body) next.notify_deadline = boolOf(body.notifyDeadline, "notifyDeadline");
  if ("notifyOffer" in body) next.notify_offer = boolOf(body.notifyOffer, "notifyOffer");
  if ("notifyComment" in body) next.notify_comment = boolOf(body.notifyComment, "notifyComment");
  if ("notifyAiDone" in body) next.notify_ai_done = boolOf(body.notifyAiDone, "notifyAiDone");
  if ("notifyApplicationStage" in body) next.notify_application_stage = boolOf(body.notifyApplicationStage, "notifyApplicationStage");
  if ("profilePublic" in body) next.profile_public = boolOf(body.profilePublic, "profilePublic");
  if ("hideFromCurrentCompany" in body) next.hide_from_current_company = boolOf(body.hideFromCurrentCompany, "hideFromCurrentCompany");
  if ("allowAiReadMyFiles" in body) next.allow_ai_read_my_files = boolOf(body.allowAiReadMyFiles, "allowAiReadMyFiles");
  if ("careerStatusVisibility" in body) {
    if (typeof body.careerStatusVisibility !== "string" || !VISIBILITY.has(body.careerStatusVisibility)) {
      throw unprocessable("careerStatusVisibility", "unsupported careerStatusVisibility");
    }
    next.career_status_visibility = body.careerStatusVisibility;
  }
  if ("contactVisibility" in body) {
    if (typeof body.contactVisibility !== "string" || !CONTACT.has(body.contactVisibility)) {
      throw unprocessable("contactVisibility", "unsupported contactVisibility");
    }
    next.contact_visibility = body.contactVisibility;
  }
  if ("defaultTone" in body) {
    if (typeof body.defaultTone !== "string" || !TONES.has(body.defaultTone)) throw unprocessable("defaultTone", "unsupported defaultTone");
    next.default_tone = body.defaultTone;
  }
  if ("locale" in body) {
    if (body.locale !== "ko" && body.locale !== "en") throw unprocessable("locale", "unsupported locale");
    await query(ctx.deps.query, "UPDATE users SET locale = $2 WHERE id = $1", [ctx.user.id, body.locale]);
    next.locale = body.locale;
  }
  if ("chatRetentionDays" in body) {
    next.chat_retention_days = body.chatRetentionDays == null ? null : intOf(body.chatRetentionDays, "chatRetentionDays", 1, 3650);
  }
  if ("defaultEffort" in body) {
    if (typeof body.defaultEffort !== "string" || !EFFORT.has(body.defaultEffort)) {
      throw unprocessable("defaultEffort", "unsupported defaultEffort");
    }
    next.default_effort = body.defaultEffort;
  }
  if ("confirmBeforeEdit" in body) next.confirm_before_edit = boolOf(body.confirmBeforeEdit, "confirmBeforeEdit");
  if ("aiAccessMode" in body) {
    if (typeof body.aiAccessMode !== "string" || !AI_ACCESS_MODES.has(body.aiAccessMode)) {
      throw fieldError("aiAccessMode", "must be ALWAYS_ASK, AUTO, or BYPASS");
    }
    next.ai_access_mode = body.aiAccessMode;
  }
  const effort = next.default_effort == null || next.default_effort === "" ? "MEDIUM" : String(next.default_effort);
  const confirmEdit = next.confirm_before_edit == null ? true : asBool(next.confirm_before_edit);
  const accessMode = next.ai_access_mode == null || next.ai_access_mode === "" ? "AUTO" : String(next.ai_access_mode);
  const params = [ctx.user.id, next.notify_deadline, next.notify_offer, next.notify_comment, next.notify_ai_done, next.profile_public,
    next.career_status_visibility, next.hide_from_current_company, next.contact_visibility, next.default_tone,
    next.chat_retention_days, next.allow_ai_read_my_files, next.notify_application_stage, ctx.now.toISOString(), effort, confirmEdit, accessMode];
  try {
    await query(ctx.deps.query, SETTINGS_UPDATE_MODE, params);
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    const message = `${(err as { message?: string }).message || ""} ${String(err)}`;
    if (message.includes("ai_access_mode")) {
      await query(ctx.deps.query, SETTINGS_UPDATE_EFFORT, params.slice(0, 16));
      return data(200, settingsDto(await loadSettings(ctx)), ctx.rid);
    }
    const legacy = params.slice(0, 14);
    try {
      await query(ctx.deps.query, SETTINGS_UPDATE, legacy);
    } catch (err2) {
      if (!isUndefinedColumn(err2)) throw err2;
      await query(ctx.deps.query, SETTINGS_UPDATE_LEGACY, legacy.filter((_, index) => index !== 12));
    }
  }
  return data(200, settingsDto(await loadSettings(ctx)), ctx.rid);
}

async function listBookmarks(ctx: Ctx): Promise<Response> {
  const loaded = await withPublicStatus(async (withStatus) => {
    const page = pageOf(ctx.url);
    const params: unknown[] = [ctx.user.id];
    const cols = withStatus ? `${POSTING_COLS}, p.status` : POSTING_COLS;
    let sql = `SELECT ${cols}, bk.created_at AS bookmark_created_at, true AS bookmarked,
      EXISTS (SELECT 1 FROM jobs j JOIN applications a ON a.job_id = j.id AND a.user_id = $1 WHERE j.source_posting_id = p.id) AS applied
      FROM bookmarks bk JOIN job_postings p ON p.id = bk.posting_id
      WHERE bk.user_id = $1 AND ${openClause(withStatus)}`;
    const total = await countWhere(ctx, sql, " FROM bookmarks bk", params.slice());
    if (page.cursor) {
      params.push(page.cursor.createdAt, page.cursor.id);
      sql += ` AND (bk.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
    }
    params.push(page.limit + 1);
    sql += ` ORDER BY bk.created_at DESC, p.id DESC LIMIT $${params.length}`;
    const rows = await query(ctx.deps.query, sql, params);
    return { rows, page, total };
  });
  const mapped = loaded.rows.rows.map((row) => ({ item: postingDto(row, false), createdAt: row.bookmark_created_at, id: String(row.id) }));
  const paged = pageResult(mapped, loaded.page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid, loaded.total);
}

export const dispatchMe = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (path === "/api/v1/me/links" && method === "GET") return listLinks(ctx);
  if (path === "/api/v1/me/links" && method === "POST") return createLink(ctx);
  const link = path.match(/^\/api\/v1\/me\/links\/([^/]+)$/);
  if (link && method === "PATCH") return updateLink(ctx, link[1]);
  if (link && method === "DELETE") return deleteLink(ctx, link[1]);
  if (path === "/api/v1/me/devices" && method === "POST") return registerDevice(ctx);
  const device = path.match(/^\/api\/v1\/me\/devices\/([^/]+)$/);
  if (device && method === "DELETE") return deleteDevice(ctx, device[1]);
  if (path === "/api/v1/me/notifications/unread" && method === "GET") return unreadNotifications(ctx);
  if (path === "/api/v1/me/notifications" && method === "GET") return listNotifications(ctx);
  if (path === "/api/v1/me/notifications/read" && method === "POST") return readNotifications(ctx);
  if (path === "/api/v1/me/settings" && method === "GET") return getSettings(ctx);
  if (path === "/api/v1/me/settings" && method === "PATCH") return patchSettings(ctx);
  if (path === "/api/v1/me/bookmarks" && method === "GET") return listBookmarks(ctx);
  return null;
};
