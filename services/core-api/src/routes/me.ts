import { isMissingRelation, isUndefinedColumn, one, query } from "../db.ts";
import { asBool, data, fieldError, jsonList, noContent, pageBody, parseUuid, requireUuid } from "../http.ts";
import { pageOf, pageResult, ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import {
  unprocessable,
  notFound,
  readObject,
  rejectFields,
  textOf,
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
  let sql = "SELECT id, kind, url, title, status, fit_count, ai_read, created_at FROM user_links WHERE user_id = $1 AND deleted_at IS NULL";
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
  const row = await one(ctx.deps.query, "UPDATE user_links SET deleted_at = $3 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id", [id, ctx.user.id, ctx.now.toISOString()]);
  if (!row) throw notFound();
  return noContent(ctx.rid);
}

async function restoreLink(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const row = await one(ctx.deps.query, "UPDATE user_links SET deleted_at = NULL WHERE id = $1 AND user_id = $2 RETURNING id, kind, url, title, status, fit_count, ai_read, created_at", [id, ctx.user.id]);
  if (!row) throw notFound();
  return data(200, linkDto(row), ctx.rid);
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
    `UPDATE user_links SET title = COALESCE($3, title), kind = COALESCE($4, kind), url = COALESCE($5, url), ai_read = COALESCE($6, ai_read) WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id, kind, url, title, status, fit_count, ai_read, created_at`,
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
    allowAiReadMyFiles: asBool(row.allow_ai_read_my_files),
    aiAccessMode: row.ai_access_mode == null || row.ai_access_mode === "" ? "AUTO" : String(row.ai_access_mode),
  };
}

const SETTINGS_SELECT = `SELECT s.notify_deadline, s.notify_offer, s.notify_comment, s.notify_ai_done, s.notify_application_stage, u.locale, s.profile_public,
            s.career_status_visibility, s.hide_from_current_company, s.contact_visibility, s.default_tone,
            s.allow_ai_read_my_files, to_jsonb(s) ->> 'ai_access_mode' AS ai_access_mode
     FROM user_settings s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1`;

const SETTINGS_UPDATE = `UPDATE user_settings SET notify_deadline = $2, notify_offer = $3, notify_comment = $4, notify_ai_done = $5,
      profile_public = $6, career_status_visibility = $7, hide_from_current_company = $8, contact_visibility = $9,
      default_tone = $10, allow_ai_read_my_files = $11, notify_application_stage = $12, updated_at = $13 WHERE user_id = $1`;

const SETTINGS_UPDATE_MODE = `UPDATE user_settings SET notify_deadline = $2, notify_offer = $3, notify_comment = $4, notify_ai_done = $5,
      profile_public = $6, career_status_visibility = $7, hide_from_current_company = $8, contact_visibility = $9,
      default_tone = $10, allow_ai_read_my_files = $11, notify_application_stage = $12, updated_at = $13,
      ai_access_mode = $14 WHERE user_id = $1`;

const SETTINGS_UPDATE_LEGACY = `UPDATE user_settings SET notify_deadline = $2, notify_offer = $3, notify_comment = $4, notify_ai_done = $5,
      profile_public = $6, career_status_visibility = $7, hide_from_current_company = $8, contact_visibility = $9,
      default_tone = $10, allow_ai_read_my_files = $11, updated_at = $12 WHERE user_id = $1`;

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
  if ("aiAccessMode" in body) {
    if (typeof body.aiAccessMode !== "string" || !AI_ACCESS_MODES.has(body.aiAccessMode)) {
      throw fieldError("aiAccessMode", "must be ALWAYS_ASK, AUTO, or BYPASS");
    }
    next.ai_access_mode = body.aiAccessMode;
  }
  const accessMode = next.ai_access_mode == null || next.ai_access_mode === "" ? "AUTO" : String(next.ai_access_mode);
  const params = [ctx.user.id, next.notify_deadline, next.notify_offer, next.notify_comment, next.notify_ai_done, next.profile_public,
    next.career_status_visibility, next.hide_from_current_company, next.contact_visibility, next.default_tone,
    next.allow_ai_read_my_files, next.notify_application_stage, ctx.now.toISOString(), accessMode];
  try {
    await query(ctx.deps.query, SETTINGS_UPDATE_MODE, params);
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    const message = `${(err as { message?: string }).message || ""} ${String(err)}`;
    if (message.includes("ai_access_mode")) {
      await query(ctx.deps.query, SETTINGS_UPDATE, params.slice(0, 13));
      return data(200, settingsDto(await loadSettings(ctx)), ctx.rid);
    }
    await query(ctx.deps.query, SETTINGS_UPDATE_LEGACY, params.filter((_, index) => index !== 11 && index !== 13));
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

const viewStamp = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  const text = String(value ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00:00.000Z`;
  return text;
};

const listPostingViews = async (ctx: Ctx): Promise<Response> => {
  try {
    const loaded = await withPublicStatus(async (withStatus) => {
      const page = pageOf(ctx.url);
      const params: unknown[] = [ctx.user.id];
      const cols = withStatus ? `${POSTING_COLS}, p.status` : POSTING_COLS;
      const flags = `EXISTS (SELECT 1 FROM bookmarks b WHERE b.user_id = $1 AND b.posting_id = p.id) AS bookmarked,
        EXISTS (SELECT 1 FROM jobs j JOIN applications a ON a.job_id = j.id AND a.user_id = $1 WHERE j.source_posting_id = p.id) AS applied`;
      const open = openClause(withStatus);
      const totalRow = await one(ctx.deps.query,
        `SELECT count(*)::int AS total FROM (
           SELECT pv.posting_id FROM posting_views pv JOIN job_postings p ON p.id = pv.posting_id
           WHERE pv.user_id = $1::uuid AND ${open} GROUP BY pv.posting_id
         ) cards`,
        params.slice());
      let sql = `SELECT ${cols}, v.viewed_on, ${flags}
        FROM (
          SELECT pv.posting_id, max(pv.viewed_on) AS viewed_on
          FROM posting_views pv WHERE pv.user_id = $1::uuid GROUP BY pv.posting_id
        ) v
        JOIN job_postings p ON p.id = v.posting_id
        WHERE ${open}`;
      if (page.cursor) {
        params.push(page.cursor.createdAt, page.cursor.id);
        sql += ` AND (v.viewed_on, p.id) < ($${params.length - 1}::date, $${params.length}::uuid)`;
      }
      params.push(page.limit + 1);
      sql += ` ORDER BY v.viewed_on DESC, p.id DESC LIMIT $${params.length}`;
      const rows = await query(ctx.deps.query, sql, params);
      return { rows, page, total: Number(totalRow?.total ?? 0) };
    });
    const mapped = loaded.rows.rows.map((row) => ({ item: postingDto(row, false), createdAt: viewStamp(row.viewed_on), id: String(row.id) }));
    const paged = pageResult(mapped, loaded.page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
    return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid, loaded.total);
  } catch (err) {
    if (!isMissingRelation(err) && !isUndefinedColumn(err)) throw err;
    return pageBody([], null, false, ctx.rid, 0);
  }
};

const DOC_STATUS_LABEL: Record<string, string> = { NONE: "서류 없음", DRAFT: "초안 있음", READY: "서류 준비됨" };

const postingIdsOf = (url: URL): string[] => {
  const all = url.searchParams.getAll("postingIds");
  if (all.length !== 1) throw fieldError("postingIds", "required");
  const tokens = all[0].split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (!tokens.length) throw fieldError("postingIds", "required");
  const ids: string[] = [];
  for (const token of tokens) {
    const id = parseUuid(token);
    if (!id) throw fieldError("postingIds", "must be a UUID");
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > 50) throw fieldError("postingIds", "too many ids");
  return ids;
};

const atStamp = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value ?? "");

const listPostingDocumentStatus = async (ctx: Ctx): Promise<Response> => {
  const ids = postingIdsOf(ctx.url);
  const apps = await query(ctx.deps.query,
    `SELECT a.id AS application_id, j.source_posting_id AS posting_id
     FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.user_id = $1::uuid AND j.source_posting_id = ANY($2::uuid[])`,
    [ctx.user.id, ids]);
  const byPosting = new Map<string, string[]>();
  for (const row of apps.rows) {
    const postingId = String(row.posting_id);
    const list = byPosting.get(postingId) ?? [];
    list.push(String(row.application_id));
    byPosting.set(postingId, list);
  }
  const appIds = apps.rows.map((row) => String(row.application_id));
  const docs = appIds.length
    ? await query(ctx.deps.query,
      `SELECT d.application_id, d.status, d.updated_at, d.id, d.user_id
       FROM documents d
       WHERE d.user_id = $1::uuid AND d.status <> 'ARCHIVED' AND d.application_id = ANY($2::uuid[])`,
      [ctx.user.id, appIds])
    : { rows: [] as Record<string, unknown>[] };
  const snaps = appIds.length
    ? await query(ctx.deps.query,
      `SELECT s.application_id FROM application_snapshots s WHERE s.application_id = ANY($1::uuid[])`,
      [appIds])
    : { rows: [] as Record<string, unknown>[] };
  const snapSet = new Set(snaps.rows.map((row) => String(row.application_id)));
  const best = new Map<string, { status: string; updatedAt: string; id: string }>();
  for (const row of docs.rows) {
    if (String(row.user_id ?? ctx.user.id) !== ctx.user.id) continue;
    if (String(row.status) === "ARCHIVED") continue;
    const appId = String(row.application_id);
    const postingId = [...byPosting.entries()].find(([, list]) => list.includes(appId))?.[0];
    if (!postingId) continue;
    const pick = { status: String(row.status), updatedAt: atStamp(row.updated_at), id: String(row.id) };
    const current = best.get(postingId);
    if (!current || pick.updatedAt > current.updatedAt || (pick.updatedAt === current.updatedAt && pick.id > current.id)) best.set(postingId, pick);
  }
  const items = ids.map((postingId) => {
    const doc = best.get(postingId);
    let status = "NONE";
    if (doc) status = doc.status === "FINALIZED" ? "READY" : doc.status === "DRAFT" ? "DRAFT" : "NONE";
    else if ((byPosting.get(postingId) ?? []).some((appId) => snapSet.has(appId))) status = "READY";
    return { postingId, status, label: DOC_STATUS_LABEL[status] };
  });
  return data(200, { items }, ctx.rid);
};

const clipText = (value: string, max: number): string => {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
};

const textItems = (value: unknown): string[] => jsonList(value).map((item) => (typeof item === "string" ? item : ""));

const listSuggestedExperiences = async (ctx: Ctx): Promise<Response> => {
  let rows: Record<string, unknown>[] = [];
  try {
    const result = await query(ctx.deps.query,
      `SELECT g.id, g.preferred_missing, g.missing, g.application_id, j.company, j.title, j.source_posting_id
       FROM gap_analyses g
       JOIN applications a ON a.id = g.application_id
       JOIN jobs j ON j.id = a.job_id
       WHERE g.user_id = $1::uuid AND a.user_id = $1::uuid
       ORDER BY g.created_at DESC, g.id DESC`,
      [ctx.user.id]);
    rows = result.rows;
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
  }
  const seen = new Set<string>();
  const items: Record<string, unknown>[] = [];
  for (const row of rows) {
    const groups: [string, unknown][] = [["preferred", row.preferred_missing], ["missing", row.missing]];
    for (const [kind, raw] of groups) {
      textItems(raw).forEach((text, index) => {
        if (items.length >= 5) return;
        const title = text.trim();
        if (!title || seen.has(title)) return;
        seen.add(title);
        const company = String(row.company ?? "").trim();
        const job = String(row.title ?? "").trim();
        items.push({
          id: `${String(row.id)}:${kind}:${index}`,
          title: clipText(title, 80),
          sub: kind === "preferred" ? "우대 사항" : "자격 요건",
          meta: company && job ? `${company} · ${job}` : company || job,
          postingId: row.source_posting_id == null || row.source_posting_id === "" ? null : String(row.source_posting_id),
          applicationId: String(row.application_id),
        });
      });
    }
    if (items.length >= 5) break;
  }
  return data(200, { items }, ctx.rid);
};

const CATEGORY_LABEL: Record<string, string> = {
  dev: "개발", data: "데이터", design: "디자인", plan: "기획", marketing: "마케팅", sales: "영업", hr: "인사", ops: "운영",
};

const categoryLabel = (value: unknown): string => CATEGORY_LABEL[String(value ?? "")] ?? "커리어";

const objectList = (value: unknown): Record<string, unknown>[] =>
  jsonList(value).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));

const nonBlank = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const listCareerTopics = async (ctx: Ctx): Promise<Response> => {
  const items: { id: string; title: string; sub: string; source: string }[] = [];
  let category: unknown = null;
  try {
    const profile = await one(ctx.deps.query, "SELECT job_category, careers FROM profiles WHERE user_id = $1::uuid", [ctx.user.id]);
    if (profile) {
      category = profile.job_category;
      const career = objectList(profile.careers).find((row) => nonBlank(row.role) || nonBlank(row.description));
      if (career) {
        const role = nonBlank(career.role);
        const description = nonBlank(career.description);
        items.push({
          id: "career",
          title: role || clipText(description, 40),
          sub: `${categoryLabel(profile.job_category)} · 이력서 경력에서`,
          source: "career",
        });
      }
    }
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
  }
  try {
    const app = await one(ctx.deps.query,
      `SELECT title FROM applications WHERE user_id = $1::uuid AND stage <> 'REJECTED' AND stage <> 'WITHDRAWN' ORDER BY updated_at DESC, id DESC LIMIT 1`,
      [ctx.user.id]);
    const title = nonBlank(app?.title);
    if (title) items.push({ id: "application", title: `${title} 준비`, sub: "커리어 · 지원 현황에서", source: "application" });
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
  }
  try {
    const gaps = await query(ctx.deps.query,
      `SELECT missing FROM gap_analyses WHERE user_id = $1::uuid ORDER BY created_at DESC, id DESC`,
      [ctx.user.id]);
    const gap = gaps.rows.map((row) => textItems(row.missing)[0] ?? "").find((text) => text.trim());
    if (gap) {
      items.push({
        id: "gap",
        title: clipText(gap.trim(), 80),
        sub: `${categoryLabel(category)} · 역량 보완에서`,
        source: "gap",
      });
    }
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
  }
  return data(200, { items: items.slice(0, 3) }, ctx.rid);
};

const TENURE_CHIP: Record<string, string> = {
  "0-2": "경력 0–2년",
  "3-5": "경력 3–5년",
  "6-9": "경력 6–9년",
  "10+": "경력 10년+",
};

const listMatchChips = async (ctx: Ctx): Promise<Response> => {
  const profile = await one(ctx.deps.query,
    "SELECT job_category, tenure_years, skills, careers FROM profiles WHERE user_id = $1::uuid",
    [ctx.user.id]);
  if (!profile) return data(200, { chips: [] }, ctx.rid);
  const chips: string[] = [];
  const label = CATEGORY_LABEL[String(profile.job_category ?? "")];
  const role = objectList(profile.careers).map((row) => nonBlank(row.role)).find((text) => text);
  if (label && role) chips.push(`${label} · ${role}`);
  else if (label) chips.push(label);
  const tenure = TENURE_CHIP[String(profile.tenure_years ?? "")];
  if (tenure) chips.push(tenure);
  for (const skill of textItems(profile.skills)) {
    const text = skill.trim();
    if (!text || chips.includes(text)) continue;
    chips.push(text);
    if (chips.length >= 8) break;
  }
  return data(200, { chips: chips.slice(0, 8) }, ctx.rid);
};

export const dispatchMe = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (path === "/api/v1/me/links" && method === "GET") return listLinks(ctx);
  if (path === "/api/v1/me/links" && method === "POST") return createLink(ctx);
  const link = path.match(/^\/api\/v1\/me\/links\/([^/]+)$/);
  if (link && method === "PATCH") return updateLink(ctx, link[1]);
  if (link && method === "DELETE") return deleteLink(ctx, link[1]);
  const restore = path.match(/^\/api\/v1\/me\/links\/([^/]+)\/restore$/);
  if (restore && method === "POST") return restoreLink(ctx, restore[1]);
  if (path === "/api/v1/me/devices" && method === "POST") return registerDevice(ctx);
  const device = path.match(/^\/api\/v1\/me\/devices\/([^/]+)$/);
  if (device && method === "DELETE") return deleteDevice(ctx, device[1]);
  if (path === "/api/v1/me/notifications/unread" && method === "GET") return unreadNotifications(ctx);
  if (path === "/api/v1/me/notifications" && method === "GET") return listNotifications(ctx);
  if (path === "/api/v1/me/notifications/read" && method === "POST") return readNotifications(ctx);
  if (path === "/api/v1/me/settings" && method === "GET") return getSettings(ctx);
  if (path === "/api/v1/me/settings" && method === "PATCH") return patchSettings(ctx);
  if (path === "/api/v1/me/bookmarks" && method === "GET") return listBookmarks(ctx);
  if (path === "/api/v1/me/posting-views" && method === "GET") return listPostingViews(ctx);
  if (path === "/api/v1/me/posting-document-status" && method === "GET") return listPostingDocumentStatus(ctx);
  if (path === "/api/v1/me/suggested-experiences" && method === "GET") return listSuggestedExperiences(ctx);
  if (path === "/api/v1/me/career-topics" && method === "GET") return listCareerTopics(ctx);
  if (path === "/api/v1/me/match-chips" && method === "GET") return listMatchChips(ctx);
  return null;
};
