import { isMissingRelation, isUndefinedColumn, isUnique, one, query } from "../db.ts";
import { enqueueIngest } from "../jobs/ingest.ts";
import { queryForms, searchFields } from "../hangul.ts";
import {
  HttpError, asBool, codePoints, data, fieldError, jsonList, noContent, pageBody, requireUuid,
} from "../http.ts";
import { pageOf, pageResult, ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import {
  JOB_CATEGORIES,
  GUEST_ID,
  unprocessable,
  notFound,
  readObject,
  rejectFields,
  textOf,
  intOf,
  dateOf,
  httpsUrl,
  stringList,
  imageKeyOf,
  imageUrl,
  jsonObject,
  splitList,
  enumList,
  pushArray,
  anyOf,
  postingDto,
  POSTING_COLS,
  openClause,
  withPublicStatus,
  countWhere,
  relevance,
  notify,
} from "./recruiting-shared.ts";

const EMPLOYMENT = new Set(["full_time", "contract", "intern", "freelance", "dispatch"]);

const CAREER_YEARS = new Set(["0", "1-3", "4-6", "7-9", "10+"]);

const POSTING_STATUSES = new Set(["DRAFT", "OPEN", "CLOSED"]);

const CAREER_BUCKETS: { id: string; alias: string; where: string }[] = [
  { id: "0", alias: "career_0", where: "p.career_min = 0" },
  { id: "1-3", alias: "career_1_3", where: "p.career_min <= 3 AND COALESCE(p.career_max, 99) >= 1" },
  { id: "4-6", alias: "career_4_6", where: "p.career_min <= 6 AND COALESCE(p.career_max, 99) >= 4" },
  { id: "7-9", alias: "career_7_9", where: "p.career_min <= 9 AND COALESCE(p.career_max, 99) >= 7" },
  { id: "10+", alias: "career_10", where: "COALESCE(p.career_max, p.career_min) >= 10" },
];

const EMPLOYER_STAGES = new Set(["SCREENING", "INTERVIEW", "OFFER", "REJECTED"]);

const TERMINAL_STAGES = new Set(["ACCEPTED", "REJECTED", "WITHDRAWN"]);

function plainList(url: URL, name: string, maxLen: number, field: string): string[] {
  const values = splitList(url, name);
  for (const value of values) {
    if (codePoints(value) > maxLen) throw fieldError(field, "too long");
  }
  return values;
}

function appendPostingFilters(
  sql: string,
  params: unknown[],
  url: URL,
  withLocation: boolean,
  skip: { category?: boolean; career?: boolean; skills?: boolean } = {},
): string {
  const q = url.searchParams.get("q") || "";
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
      p.title ILIKE '%' || $${raw} || '%' OR p.company ILIKE '%' || $${raw} || '%'
      OR ($${cho} <> '' AND p.search_choseong LIKE '%' || $${cho} || '%')
      OR ($${jamo} <> '' AND p.search_jamo LIKE $${jamo} || '%')
      OR ($${hangul} <> '' AND (
        p.title ILIKE '%' || $${hangul} || '%' OR p.company ILIKE '%' || $${hangul} || '%'
        OR p.search_jamo LIKE $${hangulJamo} || '%'
      ))
    )`;
  }
  const categories = enumList(url, "category", JOB_CATEGORIES, "category");
  if (categories.length && !skip.category) {
    const i = pushArray(params, categories);
    sql += ` AND p.job_category = ANY(${anyOf(i)})`;
  }
  const skills = plainList(url, "skills", 40, "skills");
  if (skills.length && !skip.skills) {
    const i = pushArray(params, skills);
    sql += ` AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p.skills) sk WHERE sk = ANY(${anyOf(i)}))`;
  }
  const years = enumList(url, "careerYears", CAREER_YEARS, "careerYears");
  if (years.length && !skip.career) {
    const i = pushArray(params, years);
    const arr = anyOf(i);
    const overlap = CAREER_BUCKETS.map((bucket) => `('${bucket.id}' = ANY(${arr}) AND (${bucket.where}))`).join(" OR ");
    sql += ` AND (${overlap})`;
  }
  if (withLocation) {
    const locations = plainList(url, "location", 80, "location");
    if (locations.length) {
      const i = pushArray(params, locations);
      sql += ` AND EXISTS (
        SELECT 1 FROM unnest(${anyOf(i)}) loc
        WHERE p.location = loc OR (loc <> '원격' AND p.location LIKE loc || ' %')
      )`;
    }
  }
  const employment = enumList(url, "employmentType", EMPLOYMENT, "employmentType");
  if (employment.length) {
    const i = pushArray(params, employment);
    sql += ` AND p.employment_type = ANY(${anyOf(i)})`;
  }
  return sql;
}

function postingFlags(userParam: string): string {
  return `EXISTS (SELECT 1 FROM bookmarks b WHERE b.user_id = ${userParam} AND b.posting_id = p.id) AS bookmarked,
    EXISTS (SELECT 1 FROM jobs j JOIN applications a ON a.job_id = j.id AND a.user_id = ${userParam} WHERE j.source_posting_id = p.id) AS applied`;
}

const applicantCountSql = (): string =>
  "(SELECT count(*)::int FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.source_posting_id = p.id) AS applicant_count";

const APPLICANT_COUNT_RETURNING =
  "(SELECT count(*)::int FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.source_posting_id = job_postings.id) AS applicant_count";

const detailSql = (withStatus: boolean, where: string): string =>
  `SELECT ${POSTING_COLS}${withStatus ? ", p.status" : ""}, p.description, p.requirements, p.work_conditions, ${postingFlags("$2")}, ${applicantCountSql()} FROM job_postings p WHERE ${where}`;

const postingSort = (url: URL): "latest" | "deadline" | "popular" => {
  const sort = url.searchParams.get("sort") || "latest";
  if (sort !== "latest" && sort !== "deadline" && sort !== "popular") throw unprocessable("sort", "unsupported sort");
  return sort;
};

const deadlineWindow = (ctx: Ctx, params: unknown[], where: string): string => {
  const within = ctx.url.searchParams.get("deadlineWithin");
  if (within == null || within === "") return where;
  if (within !== "7") throw unprocessable("deadlineWithin", "unsupported deadlineWithin");
  const start = ctx.now.toISOString().slice(0, 10);
  const end = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), ctx.now.getUTCDate() + 7)).toISOString().slice(0, 10);
  params.push(start, end);
  return where + ` AND p.deadline IS NOT NULL AND p.deadline >= $${params.length - 1}::date AND p.deadline <= $${params.length}::date`;
};

const recordPostingView = async (ctx: Ctx, postingId: string): Promise<void> => {
  // posting_views.user_id references users; the guest id has no row there.
  if (ctx.user.id === GUEST_ID) return;
  try {
    const inserted = await one(ctx.deps.query,
      "INSERT INTO posting_views (user_id, posting_id, viewed_on) VALUES ($1,$2,$3::date) ON CONFLICT DO NOTHING RETURNING posting_id",
      [ctx.user.id, postingId, ctx.now.toISOString().slice(0, 10)]);
    if (!inserted) return;
    await query(ctx.deps.query, "UPDATE job_postings SET view_count = COALESCE(view_count, 0) + 1 WHERE id = $1", [postingId]);
  } catch (err) {
    if (!isMissingRelation(err) && !isUndefinedColumn(err)) throw err;
  }
};

async function listPostings(ctx: Ctx): Promise<Response> {
  const sort = postingSort(ctx.url);
  const loaded = await withPublicStatus(async (withStatus) => {
    const page = pageOf(ctx.url);
    const params: unknown[] = [ctx.user.id];
    let where = ` FROM job_postings p WHERE ${openClause(withStatus)}`;
    where = appendPostingFilters(where, params, ctx.url, true);
    where = deadlineWindow(ctx, params, where);
    // $1 (the user) is only used by the row flags; Postgres rejects a bind with unused parameters, so reference it.
    const counted = one(ctx.deps.query, "SELECT count(*)::int AS total" + where + " AND $1::uuid IS NOT NULL", params.slice());
    const cols = withStatus ? `${POSTING_COLS}, p.status` : POSTING_COLS;
    let sql = `SELECT ${cols}, ${postingFlags("$1")}` + where;
    // shortcut: deadline and popular ignore the cursor; (created_at, id) is not their rank
    if (sort === "latest" && page.cursor) {
      params.push(page.cursor.createdAt, page.cursor.id);
      sql += ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
    }
    params.push(page.limit + 1);
    const order = sort === "deadline"
      ? "p.deadline ASC NULLS LAST, p.created_at DESC, p.id DESC"
      : sort === "popular"
        ? "COALESCE((to_jsonb(p) ->> 'view_count')::int, 0) DESC, p.created_at DESC, p.id DESC"
        : "p.created_at DESC, p.id DESC";
    sql += ` ORDER BY ${order} LIMIT $${params.length}`;
    const [count, rows] = await Promise.all([counted, query(ctx.deps.query, sql, params)]);
    return { total: Number(count?.total ?? 0), rows, page };
  });
  const mapped = loaded.rows.rows.map((row) => ({ item: postingDto(row, false), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, loaded.page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid, loaded.total);
}

async function listPostingLocations(ctx: Ctx): Promise<Response> {
  const rows = await withPublicStatus(async (withStatus) => {
    const params: unknown[] = [ctx.user.id];
    let sql = `SELECT p.location, count(*)::int AS count FROM job_postings p WHERE ${openClause(withStatus)} AND $1::uuid IS NOT NULL`;
    sql = appendPostingFilters(sql, params, ctx.url, false);
    sql += " GROUP BY p.location ORDER BY count DESC, p.location ASC";
    return query(ctx.deps.query, sql, params);
  });
  return data(200, rows.rows.map((row) => ({ location: String(row.location ?? ""), count: Number(row.count ?? 0) })), ctx.rid);
}

const facetWhere = (withStatus: boolean): string =>
  ` FROM job_postings p WHERE ${openClause(withStatus)} AND $1::uuid IS NOT NULL`;

const careerFacet = async (ctx: Ctx): Promise<{ id: string; count: number }[]> => {
  const row = await withPublicStatus(async (withStatus) => {
    const params: unknown[] = [ctx.user.id];
    const selects = CAREER_BUCKETS.map((bucket) => `count(*) FILTER (WHERE ${bucket.where})::int AS ${bucket.alias}`).join(", ");
    let sql = `SELECT ${selects}` + facetWhere(withStatus);
    sql = appendPostingFilters(sql, params, ctx.url, true, { career: true });
    return one(ctx.deps.query, sql, params);
  });
  return CAREER_BUCKETS.map((bucket) => ({ id: bucket.id, count: Number(row?.[bucket.alias] ?? 0) }));
};

const categoryFacet = async (ctx: Ctx): Promise<{ id: string; count: number }[]> => {
  const rows = await withPublicStatus(async (withStatus) => {
    const params: unknown[] = [ctx.user.id];
    let sql = "SELECT p.job_category AS id, count(*)::int AS count" + facetWhere(withStatus);
    sql = appendPostingFilters(sql, params, ctx.url, true, { category: true });
    sql += " GROUP BY p.job_category";
    return query(ctx.deps.query, sql, params);
  });
  const counts = new Map(rows.rows.map((item) => [String(item.id ?? ""), Number(item.count ?? 0)]));
  return [...JOB_CATEGORIES].map((id) => ({ id, count: counts.get(id) ?? 0 }));
};

const locationFacet = async (ctx: Ctx): Promise<{ id: string; count: number }[]> => {
  const rows = await withPublicStatus(async (withStatus) => {
    const params: unknown[] = [ctx.user.id];
    let sql = "SELECT p.location AS id, count(*)::int AS count" + facetWhere(withStatus);
    sql = appendPostingFilters(sql, params, ctx.url, false);
    sql += " GROUP BY p.location ORDER BY count DESC, p.location ASC";
    return query(ctx.deps.query, sql, params);
  });
  return rows.rows
    .filter((item) => Number(item.count ?? 0) > 0)
    .map((item) => ({ id: String(item.id ?? ""), count: Number(item.count ?? 0) }));
};

export const skillRows = async (ctx: Ctx, filtered: boolean): Promise<{ id: string; count: number }[]> => {
  const rows = await withPublicStatus(async (withStatus) => {
    const params: unknown[] = [ctx.user.id];
    let sql = `SELECT sk AS id, count(*)::int AS count FROM job_postings p, jsonb_array_elements_text(COALESCE(p.skills, '[]'::jsonb)) sk WHERE ${openClause(withStatus)} AND $1::uuid IS NOT NULL`;
    if (filtered) sql = appendPostingFilters(sql, params, ctx.url, true, { skills: true });
    sql += " GROUP BY sk ORDER BY count DESC, sk ASC";
    return query(ctx.deps.query, sql, params);
  });
  return rows.rows
    .filter((row) => Number(row.count ?? 0) > 0)
    .map((row) => ({ id: String(row.id ?? ""), count: Number(row.count ?? 0) }));
};

const listPostingFacets = async (ctx: Ctx): Promise<Response> => {
  const [career, category, location, skills] = await Promise.all([
    careerFacet(ctx), categoryFacet(ctx), locationFacet(ctx), skillRows(ctx, true),
  ]);
  return data(200, { career, category, location, skills }, ctx.rid);
};

async function getPosting(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const open = await withPublicStatus((withStatus) => one(ctx.deps.query,
    detailSql(withStatus, `p.id = $1 AND ${openClause(withStatus)}`),
    [id, ctx.user.id]));
  const memberOf = async (): Promise<boolean> => {
    const member = await one(ctx.deps.query,
      "SELECT p.id FROM job_postings p JOIN company_members m ON m.company_id = p.company_id AND m.user_id = $2 WHERE p.id = $1",
      [id, ctx.user.id]);
    return Boolean(member);
  };
  if (open) {
    const member = ctx.user.id !== GUEST_ID && await memberOf();
    await recordPostingView(ctx, id);
    return data(200, postingDto(open, true, member), ctx.rid);
  }
  if (ctx.user.id === GUEST_ID) throw notFound();
  if (!(await memberOf())) throw notFound();
  const closed = await withPublicStatus((withStatus) => one(ctx.deps.query, detailSql(withStatus, "p.id = $1"), [id, ctx.user.id]));
  if (!closed) throw notFound();
  await recordPostingView(ctx, id);
  return data(200, postingDto(closed, true, true), ctx.rid);
}

const verifiedCompany = async (ctx: Ctx): Promise<{ id: string; name: string }> => {
  const row = await one(ctx.deps.query,
    "SELECT c.id, c.name FROM company_members m JOIN companies c ON c.id = m.company_id WHERE m.user_id = $1 AND c.verified_at IS NOT NULL",
    [ctx.user.id]);
  if (!row) throw new HttpError(403, "FORBIDDEN", "verified company required");
  return { id: String(row.id), name: String(row.name ?? "") };
};

const snapshotText = (value: unknown): string => {
  if (value != null && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "");
};

async function createPosting(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  rejectFields(body, ["userId", "createdAt", "updatedAt", "revision", "id", "companyUserId"]);
  const title = textOf(body.title, "title", 1, 300);
  if (typeof body.jobCategory !== "string" || !JOB_CATEGORIES.has(body.jobCategory)) {
    throw unprocessable("jobCategory", "unsupported jobCategory");
  }
  const careerMin = intOf(body.careerMin, "careerMin", 0, 80);
  const careerMax = body.careerMax == null ? null : intOf(body.careerMax, "careerMax", 0, 80);
  if (careerMax != null && careerMax < careerMin) throw fieldError("careerMax", "must be greater than or equal to careerMin");
  const location = textOf(body.location, "location", 1, 80);
  if (typeof body.employmentType !== "string" || !EMPLOYMENT.has(body.employmentType)) {
    throw unprocessable("employmentType", "unsupported employmentType");
  }
  const description = textOf(body.description, "description", 1, 50000);
  const skills = stringList(body.skills, "skills", 30, 40);
  const requirements = stringList(body.requirements, "requirements", 50, 500);
  const preferred = stringList(body.preferred, "preferred", 50, 500);
  let workConditions: Record<string, unknown> = {};
  if (body.workConditions != null) {
    if (typeof body.workConditions !== "object" || Array.isArray(body.workConditions)) {
      throw fieldError("workConditions", "must be an object");
    }
    workConditions = body.workConditions as Record<string, unknown>;
  }
  const imageKey = imageKeyOf(body.imageKey, "imageKey");
  let sourceUrl: string | null = null;
  if (body.sourceUrl != null) {
    sourceUrl = textOf(body.sourceUrl, "sourceUrl", 1, 2000);
    if (!httpsUrl(sourceUrl)) throw fieldError("sourceUrl", "must be an http(s) URL without credentials");
  }
  const deadline = dateOf(body.deadline, "deadline");
  let postingStatus: "DRAFT" | "OPEN" = "OPEN";
  if (body.status != null) {
    if (body.status !== "DRAFT" && body.status !== "OPEN") throw fieldError("status", "invalid status");
    postingStatus = body.status;
  }
  const account = await verifiedCompany(ctx);
  const company = body.company == null ? account.name : textOf(body.company, "company", 1, 200);
  if (!company) throw fieldError("company", "company must be 1-200 characters");
  const fields = searchFields(`${title} ${company}`);
  const id = crypto.randomUUID();
  const now = ctx.now.toISOString();
  const base = [id, account.id, company, title, body.jobCategory, careerMin, careerMax, location, body.employmentType, description,
    JSON.stringify(requirements), JSON.stringify(workConditions), JSON.stringify(skills), JSON.stringify(preferred), imageKey, sourceUrl, deadline,
    fields.text, fields.choseong, fields.jamo, now, postingStatus];
  try {
    await query(ctx.deps.query,
      `INSERT INTO job_postings (id, company_id, company, title, job_category, career_min, career_max, location, employment_type, description, requirements, work_conditions, skills, preferred, image_key, source_url, deadline, closed_at, revision, search_text, search_choseong, search_jamo, created_at, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,NULL,1,$18,$19,$20,$21,$22,$23)`,
      [...base, ctx.user.id]);
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    await query(ctx.deps.query,
      `INSERT INTO job_postings (id, company_id, company, title, job_category, career_min, career_max, location, employment_type, description, requirements, work_conditions, skills, preferred, image_key, source_url, deadline, closed_at, revision, search_text, search_choseong, search_jamo, created_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,NULL,1,$18,$19,$20,$21,$22)`,
      base);
  }
  await enqueueIngest(ctx, { postingId: id });
  return data(201, postingDto({
    id, company, title, job_category: body.jobCategory, image_key: imageKey, skills, career_min: careerMin,
    career_max: careerMax, location, employment_type: body.employmentType, deadline, source_url: sourceUrl,
    created_at: now, bookmarked: false, applied: false, description, requirements, work_conditions: workConditions,
    preferred, revision: 1, closed_at: null, status: postingStatus, applicant_count: 0,
    new_applicant_count: 0, created_by_name: ctx.user.displayName,
  }, true, true), ctx.rid);
}

async function requireOpenPosting(ctx: Ctx, idRaw: string): Promise<string> {
  const id = requireUuid(idRaw, "id");
  const row = await withPublicStatus((withStatus) => one(ctx.deps.query,
    `SELECT p.id FROM job_postings p WHERE p.id = $1 AND ${openClause(withStatus)}`,
    [id]));
  if (!row) throw notFound();
  return id;
}

async function bookmarkPosting(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = await requireOpenPosting(ctx, idRaw);
  await query(ctx.deps.query,
    "INSERT INTO bookmarks (user_id, posting_id, created_at) VALUES ($1,$2,$3) ON CONFLICT (user_id, posting_id) DO NOTHING",
    [ctx.user.id, id, ctx.now.toISOString()]);
  return noContent(ctx.rid);
}

async function unbookmarkPosting(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const row = await one(ctx.deps.query, "SELECT id FROM job_postings WHERE id = $1", [id]);
  if (!row) throw notFound();
  await query(ctx.deps.query, "DELETE FROM bookmarks WHERE user_id = $1 AND posting_id = $2", [ctx.user.id, id]);
  return noContent(ctx.rid);
}

function applicationDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    revision: Number(row.revision ?? 1),
    jobId: String(row.job_id),
    company: String(row.company ?? ""),
    title: String(row.title ?? ""),
    stage: String(row.stage ?? "APPLIED"),
    notes: String(row.notes ?? ""),
    appliedAt: ts(row.applied_at),
    nextActionAt: ts(row.next_action_at),
    imported: asBool(row.imported),
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
    fitScore: row.fit_score == null || row.fit_score === "" ? null : Number(row.fit_score),
  };
}

const companyApplicationDto = (row: Record<string, unknown>): Record<string, unknown> => {
  const dto = applicationDto(row);
  delete dto.notes;
  return dto;
};

const APPLICATION_COLS = "a.id, a.revision, a.job_id, a.company, a.title, a.stage, a.notes, a.applied_at, a.next_action_at, a.imported, a.created_at, a.updated_at";

const existingApplication = (ctx: Ctx, postingId: string) => one(ctx.deps.query,
  `SELECT ${APPLICATION_COLS}
   FROM applications a JOIN jobs j ON j.id = a.job_id
   WHERE a.user_id = $1 AND j.source_posting_id = $2
   ORDER BY a.created_at DESC LIMIT 1`,
  [ctx.user.id, postingId]);

const idList = (value: unknown, field: string): string[] => {
  const raw = value == null ? [] : value;
  if (!Array.isArray(raw)) throw fieldError(field, "must be an array");
  return raw.map((item) => requireUuid(String(item), field));
};

/**
 * Job, application, event, document snapshots and file copies in one statement. Files are copied
 * from sources inside Postgres, so their bytes never travel through the Worker. A job is only created
 * when the caller has no application for the posting yet, which closes most of the double-apply window.
 */

const APPLY_SQL = `WITH job AS (
    INSERT INTO jobs (id, user_id, revision, company, title, source_kind, source_url, source_text, requirements, preferred, keywords, risks, deadline, language, archived, created_at, updated_at, source_posting_id, search_choseong, search_jamo)
    SELECT $1, $2, 1, $4, $5, 'TEXT', NULL, $6, $7::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $8, '', false, $9, $9, $3, $10, $11
    WHERE NOT EXISTS (SELECT 1 FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.user_id = $2 AND j.source_posting_id = $3)
    RETURNING id
  ), app AS (
    INSERT INTO applications (id, user_id, revision, job_id, company, title, stage, notes, applied_at, next_action_at, imported, created_at, updated_at)
    SELECT $12, $2, 1, job.id, $4, $5, 'APPLIED', '', $9, NULL, false, $9, $9 FROM job
    RETURNING id
  ), ev AS (
    INSERT INTO application_events (id, user_id, application_id, type, payload, created_at)
    SELECT gen_random_uuid(), $2, app.id, 'APPLIED', $13::jsonb, $9 FROM app
  ), snaps AS (
    INSERT INTO application_snapshots (id, application_id, document_id, title, content, created_at)
    SELECT gen_random_uuid(), app.id, d.document_id, d.title, d.content, $9
    FROM app, jsonb_to_recordset($14::jsonb) AS d(document_id uuid, title text, content text)
  ), files AS (
    INSERT INTO application_files (id, application_id, source_id, document_id, file_name, mime_type, size, page_count, storage_key, content, created_at)
    SELECT gen_random_uuid(), app.id, s.id, NULL, COALESCE(s.file_name, ''), COALESCE(s.mime_type, 'application/octet-stream'), COALESCE(s.size, 0),
      s.page_count, COALESCE(s.path, s.id::text), s.content, $9
    FROM app, jsonb_array_elements_text($15::jsonb) AS r(id) JOIN sources s ON s.id = r.id::uuid AND s.user_id = $2
  )
  SELECT id FROM app`;

async function applyPosting(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const posting = await withPublicStatus((withStatus) => one(ctx.deps.query,
    `SELECT p.company, p.title, p.description, p.requirements, p.deadline FROM job_postings p WHERE p.id = $1 AND ${openClause(withStatus)}`,
    [id]));
  if (!posting) throw notFound();
  if (ctx.user.accountType === "EMPLOYER") throw new HttpError(403, "FORBIDDEN", "employer account required");
  const body = await readObject(ctx.request);
  rejectFields(body, ["userId", "createdAt", "id"]);
  const documentIds = idList(body.documentIds, "documentIds");
  const sourceIds = idList(body.sourceIds, "sourceIds");
  const [docs, sources, existing] = await Promise.all([
    documentIds.length ? query(ctx.deps.query,
      `SELECT DISTINCT ON (d.id) d.id, d.title, v.content FROM documents d
       JOIN document_versions v ON v.document_id = d.id
       WHERE d.user_id = $1 AND d.id IN (SELECT jsonb_array_elements_text($2::jsonb)::uuid)
       ORDER BY d.id, v.number DESC, v.created_at DESC, v.id DESC`,
      [ctx.user.id, JSON.stringify(documentIds)]) : null,
    sourceIds.length ? query(ctx.deps.query,
      "SELECT id FROM sources WHERE user_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb)::uuid)",
      [ctx.user.id, JSON.stringify(sourceIds)]) : null,
    existingApplication(ctx, id),
  ]);
  const owned = new Map((docs?.rows ?? []).map((row) => [String(row.id), row]));
  if (documentIds.some((docId) => !owned.has(docId))) throw notFound();
  const ownedSources = new Set((sources?.rows ?? []).map((row) => String(row.id)));
  if (sourceIds.some((sourceId) => !ownedSources.has(sourceId))) throw notFound();
  if (existing) return data(201, applicationDto(existing), ctx.rid);
  const fields = searchFields(`${String(posting.title)} ${String(posting.company)}`);
  const now = ctx.now.toISOString();
  const jobId = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const snapshots = documentIds.map((docId) => {
    const doc = owned.get(docId)!;
    return { document_id: docId, title: String(doc.title ?? ""), content: snapshotText(doc.content) };
  });
  let created: Record<string, unknown> | null;
  try {
    created = await one(ctx.deps.query, APPLY_SQL, [
      jobId, ctx.user.id, id, posting.company, posting.title, posting.description, JSON.stringify(jsonList(posting.requirements)),
      posting.deadline, now, fields.choseong, fields.jamo, applicationId,
      JSON.stringify({ postingId: id, documentIds }), JSON.stringify(snapshots), JSON.stringify(sourceIds),
    ]);
  } catch (err) {
    // A unique index on jobs (user_id, source_posting_id) turns a simultaneous second apply into 23505.
    if (!isUnique(err)) throw err;
    created = null;
  }
  if (!created) {
    // A concurrent apply for the same posting won; answer with its application.
    const winner = await existingApplication(ctx, id);
    if (!winner) throw new HttpError(500, "INTERNAL", "internal error");
    return data(201, applicationDto(winner), ctx.rid);
  }
  await enqueueIngest(ctx, { jobId });
  return data(201, applicationDto({
    id: applicationId, revision: 1, job_id: jobId, company: posting.company, title: posting.title,
    stage: "APPLIED", notes: "", applied_at: now, next_action_at: null, imported: false, created_at: now, updated_at: now,
  }), ctx.rid);
}

const expectedRevisionOf = (body: Record<string, unknown>): number => {
  if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision)) {
    throw fieldError("expectedRevision", "invalid expectedRevision");
  }
  return body.expectedRevision;
};

const revisionConflict = (currentRevision: number): HttpError =>
  new HttpError(409, "REVISION_CONFLICT", "resource was modified", { currentRevision });

const POSTING_RETURNING = `id, company, title, job_category, image_key, skills, career_min, career_max, location, employment_type, deadline, source_url, created_at, revision, preferred, closed_at, description, requirements, work_conditions, status`;

const patchPosting = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const body = await readObject(ctx.request);
  rejectFields(body, ["userId", "createdAt", "updatedAt", "revision", "id", "companyUserId", "closedAt"]);
  const expected = expectedRevisionOf(body);
  if ("status" in body && body.status !== "DRAFT" && body.status !== "OPEN") {
    throw fieldError("status", "invalid status");
  }
  const company = await verifiedCompany(ctx);
  const current = await one(ctx.deps.query,
    `SELECT ${POSTING_RETURNING} FROM job_postings WHERE id = $1 AND company_id = $2`,
    [id, company.id]);
  if (!current) throw notFound();
  if (current.closed_at != null && body.status === "OPEN") throw fieldError("status", "invalid status");
  if (Number(current.revision) !== expected) throw revisionConflict(Number(current.revision));
  const next = { ...current };
  if ("title" in body) next.title = textOf(body.title, "title", 1, 300);
  if ("company" in body) next.company = textOf(body.company, "company", 1, 200);
  if ("jobCategory" in body) {
    if (typeof body.jobCategory !== "string" || !JOB_CATEGORIES.has(body.jobCategory)) {
      throw unprocessable("jobCategory", "unsupported jobCategory");
    }
    next.job_category = body.jobCategory;
  }
  if ("careerMin" in body) next.career_min = intOf(body.careerMin, "careerMin", 0, 80);
  if ("careerMax" in body) next.career_max = body.careerMax == null ? null : intOf(body.careerMax, "careerMax", 0, 80);
  const careerMin = Number(next.career_min ?? 0);
  const careerMax = next.career_max == null ? null : Number(next.career_max);
  if (careerMax != null && careerMax < careerMin) throw fieldError("careerMax", "must be greater than or equal to careerMin");
  if ("location" in body) next.location = textOf(body.location, "location", 1, 80);
  if ("employmentType" in body) {
    if (typeof body.employmentType !== "string" || !EMPLOYMENT.has(body.employmentType)) {
      throw unprocessable("employmentType", "unsupported employmentType");
    }
    next.employment_type = body.employmentType;
  }
  if ("description" in body) next.description = textOf(body.description, "description", 1, 50000);
  if ("skills" in body) next.skills = stringList(body.skills, "skills", 30, 40);
  if ("requirements" in body) next.requirements = stringList(body.requirements, "requirements", 50, 500);
  if ("preferred" in body) next.preferred = stringList(body.preferred, "preferred", 50, 500);
  if ("workConditions" in body) {
    if (body.workConditions != null && (typeof body.workConditions !== "object" || Array.isArray(body.workConditions))) {
      throw fieldError("workConditions", "must be an object");
    }
    next.work_conditions = body.workConditions ?? {};
  }
  if ("imageKey" in body) next.image_key = imageKeyOf(body.imageKey, "imageKey");
  if ("sourceUrl" in body) {
    if (body.sourceUrl == null) next.source_url = null;
    else {
      const sourceUrl = textOf(body.sourceUrl, "sourceUrl", 1, 2000);
      if (!httpsUrl(sourceUrl)) throw fieldError("sourceUrl", "must be an http(s) URL without credentials");
      next.source_url = sourceUrl;
    }
  }
  if ("deadline" in body) next.deadline = dateOf(body.deadline, "deadline");
  if ("status" in body) next.status = body.status;
  const fields = searchFields(`${String(next.title ?? "")} ${String(next.company ?? "")}`);
  const updated = await one(ctx.deps.query,
    `UPDATE job_postings SET company = $3, title = $4, job_category = $5, career_min = $6, career_max = $7, location = $8, employment_type = $9, description = $10, requirements = $11::jsonb, work_conditions = $12::jsonb, skills = $13::jsonb, preferred = $14::jsonb, image_key = $15, source_url = $16, deadline = $17, search_text = $18, search_choseong = $19, search_jamo = $20, status = $22, revision = revision + 1
     WHERE id = $1 AND company_id = $2 AND revision = $21
     RETURNING ${POSTING_RETURNING}, ${APPLICANT_COUNT_RETURNING}`,
    [id, company.id, next.company, next.title, next.job_category, careerMin, careerMax, next.location, next.employment_type, next.description,
      JSON.stringify(jsonList(next.requirements)), JSON.stringify(jsonObject(next.work_conditions)), JSON.stringify(jsonList(next.skills)), JSON.stringify(jsonList(next.preferred)),
      next.image_key ?? null, next.source_url ?? null, next.deadline ?? null, fields.text, fields.choseong, fields.jamo, expected, next.status ?? "OPEN"]);
  if (!updated) {
    const again = await one(ctx.deps.query, "SELECT revision FROM job_postings WHERE id = $1 AND company_id = $2", [id, company.id]);
    if (!again) throw notFound();
    throw revisionConflict(Number(again.revision));
  }
  return data(200, postingDto({ ...updated, bookmarked: false, applied: false }, true, true), ctx.rid);
};

const closePosting = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const body = await readObject(ctx.request);
  const expected = expectedRevisionOf(body);
  const company = await verifiedCompany(ctx);
  const current = await one(ctx.deps.query,
    "SELECT id, revision, closed_at FROM job_postings WHERE id = $1 AND company_id = $2",
    [id, company.id]);
  if (!current) throw notFound();
  if (current.closed_at != null || Number(current.revision) !== expected) {
    throw revisionConflict(Number(current.revision));
  }
  const updated = await one(ctx.deps.query,
    `UPDATE job_postings SET closed_at = $3, status = 'CLOSED', revision = revision + 1
     WHERE id = $1 AND company_id = $2 AND revision = $4 AND closed_at IS NULL
     RETURNING ${POSTING_RETURNING}, ${APPLICANT_COUNT_RETURNING}`,
    [id, company.id, ctx.now.toISOString(), expected]);
  if (!updated) {
    const again = await one(ctx.deps.query, "SELECT revision FROM job_postings WHERE id = $1 AND company_id = $2", [id, company.id]);
    if (!again) throw notFound();
    throw revisionConflict(Number(again.revision));
  }
  return data(200, postingDto({ ...updated, bookmarked: false, applied: false }, true, true), ctx.rid);
};

const listCompanyPostings = async (ctx: Ctx): Promise<Response> => {
  const member = await one(ctx.deps.query, "SELECT company_id FROM company_members WHERE user_id = $1 LIMIT 1", [ctx.user.id]);
  if (!member) throw notFound();
  const statusFilter = ctx.url.searchParams.get("status");
  if (statusFilter != null && !POSTING_STATUSES.has(statusFilter)) throw unprocessable("status", "unsupported status");
  const page = pageOf(ctx.url);
  const loaded = await withPublicStatus(async (withStatus) => {
    const params: unknown[] = [ctx.user.id, String(member.company_id)];
    let where = " FROM job_postings p WHERE p.company_id = $2";
    if (statusFilter === "DRAFT" && !withStatus) return { total: 0, rows: { rows: [], rowCount: 0 } };
    if (withStatus && statusFilter) {
      params.push(statusFilter);
      where += ` AND p.status = $${params.length}`;
    } else if (!withStatus && statusFilter === "OPEN") where += " AND p.closed_at IS NULL";
    else if (!withStatus && statusFilter === "CLOSED") where += " AND p.closed_at IS NOT NULL";
    const count = await one(ctx.deps.query, "SELECT count(*)::int AS total" + where + " AND $1::uuid IS NOT NULL", params.slice());
    const total = Number(count?.total ?? 0);
    const cols = withStatus ? `${POSTING_COLS}, p.status` : POSTING_COLS;
    const unseen = "(SELECT count(*)::int FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.source_posting_id = p.id AND (to_jsonb(a) ->> 'company_seen_at') IS NULL) AS new_applicant_count";
    const creator = "(SELECT u.display_name FROM users u WHERE u.id = NULLIF(to_jsonb(p) ->> 'created_by', '')::uuid) AS created_by_name";
    let sql = `SELECT ${cols}, ${applicantCountSql()}, ${unseen}, ${creator}, ${postingFlags("$1")}` + where;
    if (page.cursor) {
      params.push(page.cursor.createdAt, page.cursor.id);
      sql += ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
    }
    params.push(page.limit + 1);
    sql += ` ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`;
    const rows = await query(ctx.deps.query, sql, params);
    return { total, rows };
  });
  const mapped = loaded.rows.rows.map((row) => ({ item: postingDto(row, false, true), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid, loaded.total);
};

const requirePostingMember = async (ctx: Ctx, postingId: string): Promise<void> => {
  const row = await one(ctx.deps.query,
    "SELECT p.id FROM job_postings p JOIN company_members m ON m.company_id = p.company_id AND m.user_id = $2 WHERE p.id = $1",
    [postingId, ctx.user.id]);
  if (!row) throw notFound();
};

const postingApplicantCounts = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  await requirePostingMember(ctx, id);
  const row = await one(ctx.deps.query,
    `SELECT count(*) FILTER (WHERE a.stage = 'APPLIED')::int AS applied,
            count(*) FILTER (WHERE a.stage = 'SCREENING')::int AS screening,
            count(*) FILTER (WHERE a.stage = 'INTERVIEW')::int AS interview,
            count(*) FILTER (WHERE a.stage = 'OFFER')::int AS offer,
            count(*) FILTER (WHERE a.stage = 'REJECTED')::int AS rejected
     FROM applications a
     JOIN jobs j ON j.id = a.job_id
     WHERE j.source_posting_id = $1`,
    [id]);
  const applied = Number(row?.applied ?? 0);
  const screening = Number(row?.screening ?? 0);
  const interview = Number(row?.interview ?? 0);
  const offer = Number(row?.offer ?? 0);
  const rejected = Number(row?.rejected ?? 0);
  return data(200, {
    total: applied + screening + interview + offer + rejected,
    applied,
    screening,
    interview,
    offer,
    rejected,
  }, ctx.rid);
};

const APPLICANT_SQL = `SELECT a.id, a.user_id, a.revision, a.job_id, a.company, a.title, a.stage, a.notes, a.applied_at, a.next_action_at, a.imported, a.created_at, a.updated_at,
  (SELECT g.fit_score FROM gap_analyses g WHERE g.application_id = a.id ORDER BY g.created_at DESC, g.id DESC LIMIT 1) AS fit_score
  FROM applications a JOIN jobs j ON j.id = a.job_id
  WHERE a.id = $1 AND j.source_posting_id = $2`;

const loadApplicant = async (ctx: Ctx, postingId: string, applicationId: string): Promise<Record<string, unknown>> => {
  const row = await one(ctx.deps.query, APPLICANT_SQL, [applicationId, postingId]);
  if (!row) throw notFound();
  return row;
};

const listApplicants = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const postingId = requireUuid(idRaw, "id");
  await requirePostingMember(ctx, postingId);
  const stage = ctx.url.searchParams.get("stage");
  const page = pageOf(ctx.url);
  const params: unknown[] = [postingId];
  const documentsSql = (withFiles: boolean): string => {
    const files = withFiles
      ? `UNION ALL SELECT f.file_name, f.page_count, f.created_at, f.id FROM application_files f WHERE f.application_id = a.id`
      : "";
    return `COALESCE((
      SELECT json_agg(json_build_object('title', d.title, 'pages', d.pages) ORDER BY d.created_at, d.id)
      FROM (
        SELECT s.title, NULL::int AS pages, s.created_at, s.id FROM application_snapshots s WHERE s.application_id = a.id
        ${files}
      ) d
    ), '[]'::json)`;
  };
  let sql = `SELECT a.id, a.stage, a.applied_at, u.display_name, pr.headline, pr.job_category, pr.tenure_years, pr.avatar_key,
    ${documentsSql(true)} AS documents
    FROM applications a
    JOIN jobs j ON j.id = a.job_id
    JOIN users u ON u.id = a.user_id
    LEFT JOIN profiles pr ON pr.user_id = a.user_id
    WHERE j.source_posting_id = $1`;
  if (stage) {
    params.push(stage);
    sql += ` AND a.stage = $${params.length}`;
  }
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (a.applied_at, a.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY a.applied_at DESC, a.id DESC LIMIT $${params.length}`;
  let rows;
  try {
    rows = await query(ctx.deps.query, sql, params);
  } catch (err) {
    if (!isMissingRelation(err) && !isUndefinedColumn(err)) throw err;
    rows = await query(ctx.deps.query, sql.replace(documentsSql(true), documentsSql(false)), params);
  }
  const mapped = rows.rows.map((row) => ({
    item: {
      applicationId: String(row.id),
      applicant: {
        displayName: String(row.display_name ?? ""),
        headline: row.headline == null ? null : String(row.headline),
        jobCategory: row.job_category == null ? null : String(row.job_category),
        tenureYears: row.tenure_years == null || row.tenure_years === "" ? null : Number(row.tenure_years),
        avatarUrl: imageUrl(row.avatar_key),
      },
      documents: documentPages(row.documents),
      stage: String(row.stage ?? ""),
      appliedAt: ts(row.applied_at) ?? "",
    },
    createdAt: row.applied_at,
    id: String(row.id),
  }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
};

const documentPages = (value: unknown): { title: string; pages: number | null }[] => {
  let raw = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const pages = row.pages == null || row.pages === "" ? null : Number(row.pages);
    return { title: String(row.title ?? ""), pages: pages != null && Number.isFinite(pages) ? pages : null };
  });
};

const fileBytes = (value: unknown): Uint8Array<ArrayBuffer> | null => {
  if (value == null) return null;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value !== "string") return null;
  const hex = value.startsWith("\\x") ? value.slice(2) : "";
  if (!hex || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const snapshotDocuments = async (ctx: Ctx, applicationId: string): Promise<{ id: string; title: string; content: string }[]> => {
  const rows = await query(ctx.deps.query,
    "SELECT id, title, content FROM application_snapshots WHERE application_id = $1 ORDER BY created_at, id",
    [applicationId]);
  return rows.rows.map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ""),
    content: snapshotText(row.content),
  }));
};

const getApplicant = async (ctx: Ctx, postingRaw: string, applicationRaw: string): Promise<Response> => {
  const postingId = requireUuid(postingRaw, "id");
  const applicationId = requireUuid(applicationRaw, "applicationId");
  await requirePostingMember(ctx, postingId);
  const application = await loadApplicant(ctx, postingId, applicationId);
  const markSeen = async (): Promise<void> => {
    try {
      await query(ctx.deps.query,
        "UPDATE applications SET company_seen_at = $2 WHERE id = $1 AND (to_jsonb(applications) ->> 'company_seen_at') IS NULL",
        [applicationId, ctx.now.toISOString()]);
    } catch (err) {
      if (!isUndefinedColumn(err) && !isMissingRelation(err)) throw err;
    }
  };
  const [, documents, person] = await Promise.all([
    markSeen(),
    snapshotDocuments(ctx, applicationId),
    one(ctx.deps.query,
      `SELECT u.display_name, u.email, p.headline, p.careers, p.skills
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`,
      [String(application.user_id)]),
  ]);
  return data(200, {
    application: companyApplicationDto(application),
    documents,
    applicant: {
      displayName: String(person?.display_name ?? ""),
      email: person?.email == null ? "" : String(person.email),
      headline: person?.headline == null ? "" : String(person.headline),
      careers: jsonList(person?.careers),
      skills: jsonList(person?.skills).map(String),
    },
  }, ctx.rid);
};

/** RFC 6266: an ASCII fallback plus the UTF-8 name, so non-Latin-1 names do not break the header. */

const attachment = (fileName: string): string => {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_") || "file";
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

const streamApplicationFile = async (ctx: Ctx, postingRaw: string, applicationRaw: string, fileRaw: string): Promise<Response> => {
  const postingId = requireUuid(postingRaw, "id");
  const applicationId = requireUuid(applicationRaw, "applicationId");
  const fileId = requireUuid(fileRaw, "fileId");
  await requirePostingMember(ctx, postingId);
  const row = await one(ctx.deps.query,
    `SELECT f.file_name, f.mime_type, f.content
     FROM application_files f
     JOIN applications a ON a.id = f.application_id
     JOIN jobs j ON j.id = a.job_id
     WHERE f.id = $1 AND f.application_id = $2 AND j.source_posting_id = $3`,
    [fileId, applicationId, postingId]);
  const bytes = fileBytes(row?.content);
  if (!row || !bytes) throw notFound();
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": String(row.mime_type ?? "application/octet-stream"),
      "content-disposition": attachment(String(row.file_name ?? "file")),
      "content-length": String(bytes.byteLength),
      "x-content-type-options": "nosniff",
      "x-request-id": ctx.rid,
    },
  });
};

const patchApplicant = async (ctx: Ctx, postingRaw: string, applicationRaw: string): Promise<Response> => {
  const postingId = requireUuid(postingRaw, "id");
  const applicationId = requireUuid(applicationRaw, "applicationId");
  const body = await readObject(ctx.request);
  if (typeof body.stage !== "string" || !EMPLOYER_STAGES.has(body.stage)) {
    throw unprocessable("stage", "unsupported stage");
  }
  await requirePostingMember(ctx, postingId);
  const current = await loadApplicant(ctx, postingId, applicationId);
  if (String(current.stage) === body.stage) return data(200, companyApplicationDto(current), ctx.rid);
  if (TERMINAL_STAGES.has(String(current.stage))) {
    throw new HttpError(409, "INVALID_TRANSITION", "terminal stage");
  }
  const now = ctx.now.toISOString();
  const updated = await one(ctx.deps.query,
    `UPDATE applications SET stage = $3, revision = revision + 1, updated_at = $4
     WHERE id = $1 AND user_id = $2
     RETURNING id, revision, job_id, company, title, stage, notes, applied_at, next_action_at, imported, created_at, updated_at`,
    [applicationId, String(current.user_id), body.stage, now]);
  if (!updated) throw notFound();
  await notify(ctx, String(current.user_id), "APPLICATION_STAGE", "지원 상태가 바뀌었어요", "", { kind: "activity", id: applicationId });
  return data(200, companyApplicationDto(updated), ctx.rid);
};

export async function searchPostings(ctx: Ctx, q: string): Promise<Response> {
  const loaded = await withPublicStatus(async (withStatus) => {
    const page = pageOf(ctx.url);
    const forms = queryForms(q);
    const params: unknown[] = [ctx.user.id, forms.raw, forms.choseong, forms.jamo, forms.hangul, forms.hangulJamo];
    const cols = withStatus ? `${POSTING_COLS}, p.status` : POSTING_COLS;
    let sql = `SELECT ${cols}, ${postingFlags("$1")} FROM job_postings p WHERE ${openClause(withStatus)} AND (
        p.title ILIKE '%' || $2 || '%' OR p.company ILIKE '%' || $2 || '%'
        OR ($3 <> '' AND p.search_choseong LIKE '%' || $3 || '%')
        OR ($4 <> '' AND p.search_jamo LIKE $4 || '%')
        OR ($5 <> '' AND (p.title ILIKE '%' || $5 || '%' OR p.company ILIKE '%' || $5 || '%' OR p.search_jamo LIKE $6 || '%'))
      )`;
    const total = await countWhere(ctx, sql, " FROM job_postings p", params.slice());
    if (page.cursor) {
      params.push(page.cursor.createdAt, page.cursor.id);
      sql += ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
    }
    params.push(page.limit + 1);
    sql += ` ORDER BY ${relevance("p.title", "p.company")}, p.created_at DESC, p.id DESC LIMIT $${params.length}`;
    const rows = await query(ctx.deps.query, sql, params);
    return { rows, page, total };
  });
  const mapped = loaded.rows.rows.map((row) => ({ item: postingDto(row, false), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, loaded.page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid, loaded.total);
}

export const dispatchPostings = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (method === "GET" && path === "/api/v1/postings") return listPostings(ctx);
  if (method === "POST" && path === "/api/v1/postings") return createPosting(ctx);
  if (method === "GET" && path === "/api/v1/postings/facets") return listPostingFacets(ctx);
  if (method === "GET" && path === "/api/v1/postings/locations") return listPostingLocations(ctx);
  const bookmark = path.match(/^\/api\/v1\/postings\/([^/]+)\/bookmark$/);
  if (bookmark && method === "POST") return bookmarkPosting(ctx, bookmark[1]);
  if (bookmark && method === "DELETE") return unbookmarkPosting(ctx, bookmark[1]);
  const apply = path.match(/^\/api\/v1\/postings\/([^/]+)\/apply$/);
  if (apply && method === "POST") return applyPosting(ctx, apply[1]);
  if (method === "GET" && path === "/api/v1/companies/me/postings") return listCompanyPostings(ctx);
  const close = path.match(/^\/api\/v1\/postings\/([^/]+)\/close$/);
  if (close && method === "POST") return closePosting(ctx, close[1]);
  const file = path.match(/^\/api\/v1\/postings\/([^/]+)\/applicants\/([^/]+)\/files\/([^/]+)$/);
  if (file && method === "GET") return streamApplicationFile(ctx, file[1], file[2], file[3]);
  const applicant = path.match(/^\/api\/v1\/postings\/([^/]+)\/applicants\/([^/]+)$/);
  if (applicant && method === "GET") return getApplicant(ctx, applicant[1], applicant[2]);
  if (applicant && method === "PATCH") return patchApplicant(ctx, applicant[1], applicant[2]);
  const applicants = path.match(/^\/api\/v1\/postings\/([^/]+)\/applicants$/);
  if (applicants && method === "GET") return listApplicants(ctx, applicants[1]);
  const counts = path.match(/^\/api\/v1\/postings\/([^/]+)\/applicant-counts$/);
  if (counts && method === "GET") return postingApplicantCounts(ctx, counts[1]);
  const posting = path.match(/^\/api\/v1\/postings\/([^/]+)$/);
  if (posting && method === "GET") return getPosting(ctx, posting[1]);
  if (posting && method === "PATCH") return patchPosting(ctx, posting[1]);
  return null;
};
