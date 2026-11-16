import { isUndefinedColumn, isUnique, one, query, type Query } from "../db.ts";
import { queryForms, searchFields } from "../hangul.ts";
import {
  HttpError, asBool, codePoints, data, fieldError, jsonList, noContent, pageBody, parseUuid, requireUuid,
} from "../http.ts";
import { pageOf, pageResult, ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import {
  JOB_CATEGORIES,
  unprocessable,
  notFound,
  readObject,
  rejectFields,
  textOf,
  intOf,
  boolOf,
  dateOf,
  stringList,
  imageKeyOf,
  imageUrl,
  splitList,
  enumList,
  pushArray,
  anyOf,
  countWhere,
  relevance,
  NOT_DELETING,
  assertSearchCursor,
  stampSearchCursor,
  offerDto,
  OFFER_SQL,
  notify,
} from "./recruiting-shared.ts";

// Board buckets, plus legacy 0-2 so an old client still filters.
const TENURE = new Map<string, [number, number]>([
  ["0", [0, 0]],
  ["1-2", [1, 2]],
  ["3-5", [3, 5]],
  ["6-9", [6, 9]],
  ["10+", [10, 80]],
  ["0-2", [0, 2]],
]);

const CAREER_STATUS = new Set(["satisfied", "seeking", "feedback"]);

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "naver.com", "daum.net", "hanmail.net", "kakao.com",
  "outlook.com", "hotmail.com", "icloud.com", "yahoo.com",
]);

const PROFILE_COLS = `p.user_id, u.display_name, p.avatar_key, p.headline, p.job_category, p.tenure_years, p.career_status,
  p.open_to_offers, p.intro, p.careers, p.skills, p.resume_source_id, p.updated_at`;

function profileDto(row: Record<string, unknown>, viewerId: string, viewer: ViewerCompany): Record<string, unknown> {
  const visibility = String(row.career_status_visibility ?? "everyone");
  const following = asBool(row.following);
  const self = String(row.user_id) === viewerId;
  const showStatus = !sameCompanyHidden(row, viewerId, viewer) && (self || visibility === "everyone" || (visibility === "followers" && following));
  return {
    userId: String(row.user_id),
    displayName: String(row.display_name ?? ""),
    avatarUrl: imageUrl(row.avatar_key),
    headline: String(row.headline ?? ""),
    jobCategory: row.job_category == null ? null : String(row.job_category),
    tenureYears: row.tenure_years == null ? null : Number(row.tenure_years),
    careerStatus: showStatus && row.career_status != null ? String(row.career_status) : null,
    openToOffers: asBool(row.open_to_offers),
    intro: String(row.intro ?? ""),
    careers: jsonList(row.careers),
    skills: jsonList(row.skills).map(String),
    followerCount: Number(row.follower_count ?? 0),
    followingCount: Number(row.following_count ?? 0),
    postCount: Number(row.post_count ?? 0),
    resumeSourceId: row.resume_source_id == null ? null : String(row.resume_source_id),
    contact: visibleContact(row, self, following),
    updatedAt: ts(row.updated_at),
  };
}

function visibleContact(row: Record<string, unknown>, self: boolean, following: boolean): string | null {
  const value = row.contact == null ? "" : String(row.contact);
  const visibility = String(row.contact_visibility ?? "accepted");
  const shown = self
    || visibility === "everyone"
    || (visibility === "followers" && following)
    || (visibility === "accepted" && asBool(row.offer_accepted));
  return shown ? value : null;
}

function profileSelect(extra: string): string {
  return `SELECT ${PROFILE_COLS},
    COALESCE(s.career_status_visibility, 'everyone') AS career_status_visibility,
    COALESCE(s.profile_public, true) AS profile_public,
    COALESCE(s.hide_from_current_company, false) AS hide_from_current_company,
    split_part(lower(COALESCE(u.email, '')), '@', 2) AS email_domain,
    EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = p.user_id) AS following,
    (SELECT count(*)::int FROM follows f WHERE f.followee_id = p.user_id) AS follower_count,
    (SELECT count(*)::int FROM follows f WHERE f.follower_id = p.user_id) AS following_count,
    (SELECT count(*)::int FROM posts po WHERE po.user_id = p.user_id) AS post_count,
    COALESCE(s.contact_visibility, 'accepted') AS contact_visibility,
    to_jsonb(p) ->> 'contact' AS contact,
    EXISTS (SELECT 1 FROM offers o WHERE o.status = 'ACCEPTED' AND ((o.sender_id = $1 AND o.profile_user_id = p.user_id) OR (o.profile_user_id = $1 AND o.sender_id = p.user_id))) AS offer_accepted
    ${extra}
    FROM profiles p
    JOIN users u ON u.id = p.user_id AND ${NOT_DELETING}
    LEFT JOIN user_settings s ON s.user_id = p.user_id`;
}

type ViewerCompany = { domain: string; freeMail: boolean };

const viewerCompanyOf = async (ctx: Ctx): Promise<ViewerCompany> => {
  const me = await one(ctx.deps.query, "SELECT email FROM users WHERE id = $1", [ctx.user.id]);
  const email = me?.email == null ? "" : String(me.email);
  const domain = email.includes("@") ? email.split("@")[1].toLowerCase() : "";
  return { domain, freeMail: FREE_MAIL.has(domain) };
};

const sameCompanyHidden = (row: Record<string, unknown>, viewerId: string, viewer: ViewerCompany): boolean => {
  if (String(row.user_id) === viewerId) return false;
  if (!asBool(row.hide_from_current_company) && !asBool(row.hide_career_from_viewer)) return false;
  if (asBool(row.hide_career_from_viewer)) return true;
  if (!viewer.domain || viewer.freeMail) return false;
  return String(row.email_domain ?? "") === viewer.domain;
};

async function listProfiles(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const onSearch = ctx.url.pathname === "/api/v1/search";
  const sort = onSearch && ctx.url.searchParams.get("sort") === "latest" ? "latest" : "relevance";
  if (onSearch) assertSearchCursor(ctx.url, sort);
  const categories = enumList(ctx.url, "category", JOB_CATEGORIES, "category");
  const tenures = splitList(ctx.url, "tenure");
  for (const token of tenures) {
    if (!TENURE.has(token)) throw unprocessable("tenure", "unsupported tenure");
  }
  const statuses = splitList(ctx.url, "status");
  for (const token of statuses) {
    if (!CAREER_STATUS.has(token)) throw unprocessable("status", "unsupported status");
  }
  const explore = ctx.url.searchParams.get("explore");
  if (explore && explore !== "recommended" && explore !== "offers" && explore !== "received") {
    throw unprocessable("explore", "unsupported explore");
  }
  const viewer = await viewerCompanyOf(ctx);
  const params: unknown[] = [ctx.user.id, viewer.domain, viewer.freeMail];
  let sql = profileSelect(`, (
        COALESCE(s.hide_from_current_company, false)
        AND $2 <> '' AND $3 = false
        AND split_part(lower(COALESCE(u.email, '')), '@', 2) = $2
      ) AS hide_career_from_viewer`) + `
    WHERE COALESCE(s.profile_public, true) = true
      AND p.user_id <> $1`;
  if (categories.length) {
    const i = pushArray(params, categories);
    sql += ` AND p.job_category = ANY(${anyOf(i)})`;
  }
  if (tenures.length) {
    const parts: string[] = [];
    for (const token of tenures) {
      const range = TENURE.get(token)!;
      params.push(range[0], range[1]);
      parts.push(`p.tenure_years BETWEEN $${params.length - 1} AND $${params.length}`);
    }
    sql += ` AND (${parts.join(" OR ")})`;
  }
  if (statuses.length) {
    const statusParam = pushArray(params, statuses);
    sql += ` AND p.career_status = ANY(${anyOf(statusParam)})
      AND (
        COALESCE(s.career_status_visibility, 'everyone') = 'everyone'
        OR (COALESCE(s.career_status_visibility, 'everyone') = 'followers'
            AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = p.user_id))
      )
      AND NOT (
        COALESCE(s.hide_from_current_company, false)
        AND $2 <> '' AND $3 = false
        AND split_part(lower(COALESCE(u.email, '')), '@', 2) = $2
      )`;
  }
  if (explore === "recommended") {
    sql += " AND p.job_category IS NOT NULL AND p.job_category = (SELECT job_category FROM profiles WHERE user_id = $1)";
  }
  if (explore === "offers") {
    sql += " AND EXISTS (SELECT 1 FROM offers o WHERE o.sender_id = $1 AND o.profile_user_id = p.user_id)";
  }
  if (explore === "received") {
    sql += " AND EXISTS (SELECT 1 FROM offers o WHERE o.profile_user_id = $1 AND o.sender_id = p.user_id)";
  }
  const q = ctx.url.searchParams.get("q") || "";
  let rank = "";
  if (q) {
    if (codePoints(q) > 200) throw fieldError("q", "must be at most 200 characters");
    const forms = queryForms(q);
    params.push(forms.raw, forms.choseong, forms.jamo, forms.hangul, forms.hangulJamo);
    const raw = params.length - 4;
    const cho = params.length - 3;
    const jamo = params.length - 2;
    const hangul = params.length - 1;
    const hangulJamo = params.length;
    sql += ` AND (
      u.display_name ILIKE '%' || $${raw} || '%' ESCAPE '\\' OR p.headline ILIKE '%' || $${raw} || '%' ESCAPE '\\' OR p.search_text ILIKE '%' || $${raw} || '%' ESCAPE '\\'
      OR ($${cho} <> '' AND p.search_choseong LIKE '%' || $${cho} || '%' ESCAPE '\\')
      OR ($${jamo} <> '' AND p.search_jamo LIKE $${jamo} || '%' ESCAPE '\\')
      OR ($${hangul} <> '' AND (u.display_name ILIKE '%' || $${hangul} || '%' ESCAPE '\\' OR p.search_jamo LIKE $${hangulJamo} || '%' ESCAPE '\\'))
    )`;
    rank = relevance("u.display_name", "p.headline", "$" + raw, "$" + cho, "$" + hangul) + ", ";
  }
  if (sort === "latest") rank = "";
  const total = await countWhere(ctx, sql, " FROM profiles p", params.slice());
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (p.updated_at, p.user_id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY ${rank}p.updated_at DESC, p.user_id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({
    item: profileDto(row, ctx.user.id, viewer),
    createdAt: row.updated_at,
    id: String(row.user_id),
  }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  const next = onSearch ? stampSearchCursor(paged.nextCursor, sort) : paged.nextCursor;
  return pageBody(paged.items.map((row) => row.item), next, paged.hasMore, ctx.rid, total);
}

export async function searchPeople(ctx: Ctx, q: string): Promise<Response> {
  const url = new URL(ctx.url);
  url.searchParams.set("q", q);
  const next = { ...ctx, url };
  return listProfiles(next);
}

async function loadProfile(ctx: Ctx, userId: string): Promise<Record<string, unknown> | null> {
  return one(ctx.deps.query,
    profileSelect(", EXISTS (SELECT 1 FROM offers o WHERE o.sender_id = $1 AND o.profile_user_id = p.user_id) AS offered")
      + " WHERE p.user_id = $2",
    [ctx.user.id, userId]);
}

async function getProfile(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "userId");
  const [viewer, row] = await Promise.all([viewerCompanyOf(ctx), loadProfile(ctx, id)]);
  if (!row) throw notFound();
  const self = id === ctx.user.id;
  if (!self && !asBool(row.profile_public)) throw notFound();
  const dto = profileDto(row, ctx.user.id, viewer);
  return data(200, { ...dto, following: asBool(row.following), offered: asBool(row.offered) }, ctx.rid);
}

async function ensureProfile(ctx: Ctx): Promise<void> {
  await query(ctx.deps.query,
    "INSERT INTO profiles (user_id, created_at, updated_at) VALUES ($1,$2,$2) ON CONFLICT (user_id) DO NOTHING",
    [ctx.user.id, ctx.now.toISOString()]);
}

async function getMyProfile(ctx: Ctx): Promise<Response> {
  await ensureProfile(ctx);
  const viewer = await viewerCompanyOf(ctx);
  const row = await loadProfile(ctx, ctx.user.id);
  if (!row) throw notFound();
  const dto = profileDto(row, ctx.user.id, viewer);
  return data(200, { ...dto, following: false, offered: false }, ctx.rid);
}

function careersOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw fieldError("careers", "must be an array");
  if (value.length > 30) throw fieldError("careers", "too many items");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw fieldError("careers", "invalid career");
    const row = item as Record<string, unknown>;
    return {
      company: textOf(row.company, "careers", 1, 200),
      role: textOf(row.role, "careers", 1, 200),
      startedOn: dateOf(row.startedOn, "startedOn"),
      endedOn: dateOf(row.endedOn ?? null, "endedOn"),
      description: textOf(row.description ?? "", "careers", 0, 500),
    };
  });
}

const PROFILE_SELECT = `SELECT u.display_name, p.headline, p.job_category, p.tenure_years, p.career_status, p.open_to_offers, p.intro, p.careers, p.skills, p.avatar_key, p.resume_source_id
     FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = $1`;

/** What a profile change can move. The Bot's update_my_profile and PATCH both write these; contact is a plain column the Bot's tool cannot send (ProfilePatch is displayName and headline), so it is not kept. */
type ProfileValues = {
  displayName: string; headline: string; jobCategory: string | null; tenureYears: number | null; careerStatus: string | null;
  openToOffers: boolean; intro: string; careers: unknown[]; skills: string[]; avatarKey: string | null; resumeSourceId: string | null;
};

const valuesOf = (row: Record<string, unknown>): ProfileValues => ({
  displayName: String(row.display_name ?? ""),
  headline: String(row.headline ?? ""),
  jobCategory: row.job_category == null ? null : String(row.job_category),
  tenureYears: row.tenure_years == null ? null : Number(row.tenure_years),
  careerStatus: row.career_status == null ? null : String(row.career_status),
  openToOffers: asBool(row.open_to_offers),
  intro: String(row.intro ?? ""),
  careers: jsonList(row.careers),
  skills: jsonList(row.skills).map(String),
  avatarKey: row.avatar_key == null ? null : String(row.avatar_key),
  resumeSourceId: row.resume_source_id == null ? null : String(row.resume_source_id),
});

/** users and profiles move together, so a write is one transaction (the plain query only where no database session exists, as in tests). */
const inOneTransaction = <T>(ctx: Ctx, work: (q: Query) => Promise<T>): Promise<T> =>
  (ctx.deps.transaction ?? ((run) => run(ctx.deps.query)))(work);

async function writeValues(ctx: Ctx, q: Query, v: ProfileValues): Promise<void> {
  const fields = searchFields([v.displayName, v.headline, v.skills.join(" ")].join(" "));
  await query(q, "UPDATE users SET display_name = $2 WHERE id = $1", [ctx.user.id, v.displayName]);
  await query(q,
    `UPDATE profiles SET headline = $2, job_category = $3, tenure_years = $4, career_status = $5, open_to_offers = $6, intro = $7, careers = $8::jsonb, skills = $9::jsonb, avatar_key = $10, resume_source_id = $11, search_text = $12, search_choseong = $13, search_jamo = $14, updated_at = $15 WHERE user_id = $1`,
    [ctx.user.id, v.headline, v.jobCategory, v.tenureYears, v.careerStatus, v.openToOffers, v.intro, JSON.stringify(v.careers), JSON.stringify(v.skills), v.avatarKey, v.resumeSourceId, fields.text, fields.choseong, fields.jamo, ctx.now.toISOString()]);
}

async function myProfileResponse(ctx: Ctx, extra: Record<string, unknown> = {}): Promise<Response> {
  const viewer = await viewerCompanyOf(ctx);
  const row = await loadProfile(ctx, ctx.user.id);
  if (!row) throw notFound();
  return data(200, { ...profileDto(row, ctx.user.id, viewer), following: false, offered: false, ...extra }, ctx.rid);
}

async function patchMyProfile(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  rejectFields(body, ["userId", "createdAt", "updatedAt", "followerCount", "followingCount", "postCount", "following", "offered"]);
  await ensureProfile(ctx);
  const current = await one(ctx.deps.query, PROFILE_SELECT, [ctx.user.id]);
  if (!current) throw notFound();
  const was = valuesOf(current);
  const next: ProfileValues = { ...was };
  if ("displayName" in body) next.displayName = textOf(body.displayName, "displayName", 1, 80);
  if ("headline" in body) next.headline = textOf(body.headline ?? "", "headline", 0, 120);
  if ("jobCategory" in body) {
    if (body.jobCategory == null || body.jobCategory === "") next.jobCategory = null;
    else if (typeof body.jobCategory !== "string" || !JOB_CATEGORIES.has(body.jobCategory)) throw unprocessable("jobCategory", "unsupported jobCategory");
    else next.jobCategory = body.jobCategory;
  }
  if ("tenureYears" in body) next.tenureYears = body.tenureYears == null ? null : intOf(body.tenureYears, "tenureYears", 0, 80);
  if ("careerStatus" in body) {
    if (body.careerStatus == null || body.careerStatus === "") next.careerStatus = null;
    else if (typeof body.careerStatus !== "string" || !CAREER_STATUS.has(body.careerStatus)) throw unprocessable("careerStatus", "unsupported careerStatus");
    else next.careerStatus = body.careerStatus;
  }
  if ("openToOffers" in body) next.openToOffers = boolOf(body.openToOffers, "openToOffers");
  if ("intro" in body) next.intro = textOf(body.intro ?? "", "intro", 0, 2000);
  if ("careers" in body) next.careers = careersOf(body.careers);
  if ("skills" in body) next.skills = stringList(body.skills, "skills", 50, 40);
  if ("avatarKey" in body) next.avatarKey = imageKeyOf(body.avatarKey, "avatarKey");
  if ("resumeSourceId" in body) {
    if (body.resumeSourceId == null || body.resumeSourceId === "") next.resumeSourceId = null;
    else {
      next.resumeSourceId = requireUuid(String(body.resumeSourceId), "resumeSourceId");
      const source = await one(ctx.deps.query, "SELECT id FROM sources WHERE id = $1 AND user_id = $2", [next.resumeSourceId, ctx.user.id]);
      if (!source) throw notFound();
    }
  }
  // A Bot run sends its Idempotency-Key: the old values are kept under it in the same transaction as the write, so a change exists exactly when its write landed.
  const changeId = parseUuid(ctx.request.headers.get("idempotency-key") || "");
  const before: Record<string, unknown> = {};
  if (changeId) for (const key of Object.keys(was) as (keyof ProfileValues)[]) if (JSON.stringify(was[key]) !== JSON.stringify(next[key])) before[key] = was[key];
  const contact = "contact" in body ? textOf(body.contact ?? "", "contact", 0, 200) : null;
  await inOneTransaction(ctx, async (q) => {
    if (changeId && Object.keys(before).length) {
      await query(q,
        "INSERT INTO profile_changes (user_id, id, before, created_at) VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (user_id, id) DO NOTHING",
        [ctx.user.id, changeId, JSON.stringify(before), ctx.now.toISOString()]);
    }
    await writeValues(ctx, q, next);
    if (contact !== null) {
      // A failed statement aborts the transaction, so the old-schema fallback runs behind a savepoint.
      await query(q, "SAVEPOINT contact_write");
      try {
        await query(q, "UPDATE profiles SET contact = $2 WHERE user_id = $1", [ctx.user.id, contact]);
      } catch (err) {
        if (!isUndefinedColumn(err)) throw err;
        await query(q, "ROLLBACK TO SAVEPOINT contact_write");
      }
    }
  });
  const kept = changeId ? await one(ctx.deps.query, "SELECT id FROM profile_changes WHERE user_id = $1 AND id = $2", [ctx.user.id, changeId]) : null;
  return myProfileResponse(ctx, kept ? { changeId } : {});
}

async function getProfileChange(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const row = await one(ctx.deps.query, "SELECT id, before, created_at, undone_at FROM profile_changes WHERE user_id = $1 AND id = $2", [ctx.user.id, id]);
  if (!row) throw notFound();
  return data(200, {
    id,
    fields: Object.keys(row.before && typeof row.before === "object" ? row.before as object : {}),
    undone: row.undone_at != null,
    createdAt: ts(row.created_at),
  }, ctx.rid);
}

/** Puts back the values the change replaced, once. A second call is 409, so a later edit is never overwritten by a stale undo. */
async function undoProfileChange(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  // Claim, read and write are one transaction: a failed write rolls the claim back, so the person can try again and nothing is half put back.
  await inOneTransaction(ctx, async (q) => {
    const claimed = await one(q,
      "UPDATE profile_changes SET undone_at = $3 WHERE user_id = $1 AND id = $2 AND undone_at IS NULL RETURNING before",
      [ctx.user.id, id, ctx.now.toISOString()]);
    if (!claimed) {
      const exists = await one(q, "SELECT 1 AS found FROM profile_changes WHERE user_id = $1 AND id = $2", [ctx.user.id, id]);
      if (!exists) throw notFound();
      throw new HttpError(409, "CONFLICT", "change already undone");
    }
    const current = await one(q, PROFILE_SELECT, [ctx.user.id]);
    if (!current) throw notFound();
    const values = { ...valuesOf(current), ...(claimed.before as Partial<ProfileValues>) };
    if (values.resumeSourceId && !(await one(q, "SELECT id FROM sources WHERE id = $1 AND user_id = $2", [values.resumeSourceId, ctx.user.id]))) values.resumeSourceId = null;
    await writeValues(ctx, q, values);
  });
  return myProfileResponse(ctx);
}

async function offerProfile(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "userId");
  const body = await readObject(ctx.request);
  rejectFields(body, ["userId", "createdAt", "id", "status"]);
  if (id === ctx.user.id) throw new HttpError(400, "VALIDATION_ERROR", "cannot offer yourself", { field: "userId" });
  const message = textOf(body.message, "message", 1, 500);
  let postingId: string | null = null;
  if (body.postingId != null && body.postingId !== "") {
    postingId = requireUuid(String(body.postingId), "postingId");
    // Only the sender's own company's posting: attaching another company's posting would impersonate it.
    const posting = await one(ctx.deps.query,
      "SELECT p.id FROM job_postings p JOIN company_members m ON m.company_id = p.company_id AND m.user_id = $2 WHERE p.id = $1 AND p.closed_at IS NULL",
      [postingId, ctx.user.id]);
    if (!posting) throw notFound();
  }
  const profile = await one(ctx.deps.query,
    `SELECT p.user_id, p.open_to_offers, COALESCE(s.profile_public, true) AS profile_public
     FROM profiles p LEFT JOIN user_settings s ON s.user_id = p.user_id WHERE p.user_id = $1`,
    [id]);
  if (!profile || !asBool(profile.profile_public)) throw notFound();
  const blocked = await one(ctx.deps.query, "SELECT 1 AS blocked FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2", [id, ctx.user.id]);
  if (blocked) throw new HttpError(403, "BLOCKED", "this user is not accepting offers from you");
  if (!asBool(profile.open_to_offers)) throw new HttpError(403, "FORBIDDEN", "profile is not accepting offers");
  const offerId = crypto.randomUUID();
  const now = ctx.now.toISOString();
  try {
    await query(ctx.deps.query,
      "INSERT INTO offers (id, sender_id, profile_user_id, message, posting_id, status, read_at, created_at) VALUES ($1,$2,$3,$4,$5,'SENT',NULL,$6)",
      [offerId, ctx.user.id, id, message, postingId, now]);
  } catch (err) {
    if (isUnique(err)) throw new HttpError(409, "CONFLICT", "offer already sent");
    throw err;
  }
  await notify(ctx, id, "OFFER", "새 제안", message, { kind: "offer", id: offerId });
  const row = await one(ctx.deps.query, "SELECT " + OFFER_SQL + " WHERE o.id = $1", [offerId]);
  if (!row) throw notFound();
  return data(201, offerDto(row), ctx.rid);
}

async function followUser(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "userId");
  if (id === ctx.user.id) throw new HttpError(400, "VALIDATION_ERROR", "cannot follow yourself", { field: "userId" });
  const user = await one(ctx.deps.query, "SELECT id FROM users WHERE id = $1", [id]);
  if (!user) throw notFound();
  await query(ctx.deps.query,
    "INSERT INTO follows (follower_id, followee_id, created_at) VALUES ($1,$2,$3) ON CONFLICT (follower_id, followee_id) DO NOTHING",
    [ctx.user.id, id, ctx.now.toISOString()]);
  return noContent(ctx.rid);
}

async function unfollowUser(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "userId");
  if (id === ctx.user.id) throw new HttpError(400, "VALIDATION_ERROR", "cannot follow yourself", { field: "userId" });
  const user = await one(ctx.deps.query, "SELECT id FROM users WHERE id = $1", [id]);
  if (!user) throw notFound();
  await query(ctx.deps.query, "DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2", [ctx.user.id, id]);
  return noContent(ctx.rid);
}

async function listRelation(ctx: Ctx, incoming: boolean): Promise<Response> {
  const viewer = await viewerCompanyOf(ctx);
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  const join = incoming ? "f.follower_id" : "f.followee_id";
  const mine = incoming ? "f.followee_id" : "f.follower_id";
  let sql = profileSelect(", f.created_at AS relation_created_at") + ` JOIN follows f ON ${join} = p.user_id WHERE ${mine} = $1 AND COALESCE(s.profile_public, true) = true`;
  const total = await countWhere(ctx, sql, " FROM profiles p", params.slice());
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (f.created_at, p.user_id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY f.created_at DESC, p.user_id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: profileDto(row, ctx.user.id, viewer), createdAt: row.relation_created_at, id: String(row.user_id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid, total);
}

export const dispatchProfiles = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (method === "GET" && path === "/api/v1/profiles") return listProfiles(ctx);
  const offer = path.match(/^\/api\/v1\/profiles\/([^/]+)\/offer$/);
  if (offer && method === "POST") return offerProfile(ctx, offer[1]);
  const profile = path.match(/^\/api\/v1\/profiles\/([^/]+)$/);
  if (profile && method === "GET") return getProfile(ctx, profile[1]);
  const follow = path.match(/^\/api\/v1\/users\/([^/]+)\/follow$/);
  if (follow && method === "POST") return followUser(ctx, follow[1]);
  if (follow && method === "DELETE") return unfollowUser(ctx, follow[1]);
  if (path === "/api/v1/me/profile" && method === "GET") return getMyProfile(ctx);
  if (path === "/api/v1/me/profile" && method === "PATCH") return patchMyProfile(ctx);
  const change = path.match(/^\/api\/v1\/me\/profile\/changes\/([^/]+)(\/undo)?$/);
  if (change && !change[2] && method === "GET") return getProfileChange(ctx, change[1]);
  if (change && change[2] && method === "POST") return undoProfileChange(ctx, change[1]);
  if (path === "/api/v1/me/follows" && method === "GET") return listRelation(ctx, false);
  if (path === "/api/v1/me/followers" && method === "GET") return listRelation(ctx, true);
  return null;
};
