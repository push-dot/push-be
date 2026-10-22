import { parseTimeField, strictBody } from "../body.ts";
import { one, query } from "../db.ts";
import { HttpError, data, fieldError, hashJson, pageBody, requireUuid } from "../http.ts";
import { pageOf, pageResult, ts, type Page } from "../page.ts";
import type { Ctx } from "../types.ts";

const STAGE_ORDER = ["DISCOVERED", "PREPARING", "READY", "APPLIED", "SCREENING", "INTERVIEW", "OFFER", "ACCEPTED"];
const TERMINAL = new Set(["ACCEPTED", "REJECTED", "WITHDRAWN"]);
const MANUAL = "MANUAL_RECORD";
const ADAPTER = "ADAPTER";

const APP_COLS = "id, user_id, revision, job_id, company, title, stage, notes, applied_at, next_action_at, imported, created_at, updated_at";
const APP_SELECT = APP_COLS + ", (SELECT g.fit_score FROM gap_analyses g WHERE g.application_id = applications.id ORDER BY g.created_at DESC, g.id DESC LIMIT 1) AS fit_score";
const EVENT_COLS = "id, user_id, application_id, type, payload, created_at";
const DRAFT_COLS = "id, user_id, application_id, application_revision, mode, adapter, document_version_ids, confirmed_submitted, payload_hash, created_at";
const SUB_COLS = "id, user_id, application_id, mode, adapter, status, document_version_ids, approval_id, receipt_url, error_code, created_at, updated_at";

type Row = Record<string, unknown>;

const validStage = (stage: string): boolean => STAGE_ORDER.includes(stage) || stage === "REJECTED" || stage === "WITHDRAWN";
const afterApplied = (stage: string): boolean => stage === "SCREENING" || stage === "INTERVIEW" || stage === "OFFER";

const canPatchStage = (from: string, to: string): boolean => {
  if (from === to) return true;
  if (TERMINAL.has(from)) return false;
  if (to === "REJECTED" || to === "WITHDRAWN") return true;
  if (to === "APPLIED") return false;
  return STAGE_ORDER.indexOf(to) === STAGE_ORDER.indexOf(from) + 1;
};

const notFound = (): HttpError => new HttpError(404, "NOT_FOUND", "resource not found");
const conflict = (current: unknown): HttpError => new HttpError(409, "REVISION_CONFLICT", "resource was modified", { currentRevision: Number(current) });
const transition = (message: string): HttpError => new HttpError(409, "INVALID_TRANSITION", message);
const approvalRequired = (message: string): HttpError => new HttpError(409, "APPROVAL_REQUIRED", message);
const approvalStale = (message: string): HttpError => new HttpError(409, "APPROVAL_STALE", message);

const uuids = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

const appDto = (row: Row): Row => {
  const out: Row = {
    id: String(row.id),
    revision: Number(row.revision),
    jobId: String(row.job_id),
    company: String(row.company),
    title: String(row.title),
    stage: String(row.stage),
    notes: String(row.notes ?? ""),
    appliedAt: ts(row.applied_at),
    nextActionAt: ts(row.next_action_at),
    imported: Boolean(row.imported),
  };
  if (row.fit_score != null) out.fitScore = Number(row.fit_score);
  out.createdAt = ts(row.created_at);
  out.updatedAt = ts(row.updated_at);
  return out;
};

const eventDto = (row: Row): Row => ({
  id: String(row.id),
  applicationId: String(row.application_id),
  type: String(row.type),
  payload: row.payload ?? {},
  createdAt: ts(row.created_at),
});

const draftDto = (row: Row): Row => ({
  id: String(row.id),
  applicationId: String(row.application_id),
  applicationRevision: Number(row.application_revision),
  mode: String(row.mode),
  adapter: row.adapter == null ? null : String(row.adapter),
  documentVersionIds: uuids(row.document_version_ids),
  confirmedSubmitted: Boolean(row.confirmed_submitted),
  payloadHash: String(row.payload_hash),
  createdAt: ts(row.created_at),
});

const submissionDto = (row: Row): Row => ({
  id: String(row.id),
  applicationId: String(row.application_id),
  mode: String(row.mode),
  adapter: row.adapter == null ? null : String(row.adapter),
  status: String(row.status),
  documentVersionIds: uuids(row.document_version_ids),
  approvalId: row.approval_id == null ? null : String(row.approval_id),
  receiptUrl: row.receipt_url == null ? null : String(row.receipt_url),
  errorCode: row.error_code == null ? null : String(row.error_code),
  createdAt: ts(row.created_at),
  updatedAt: ts(row.updated_at),
});

const listPage = async (ctx: Ctx, cols: string, table: string, where: string[], params: unknown[], page: Page, dto: (row: Row) => Row): Promise<Response> => {
  const args = [...params];
  const conds = [...where];
  if (page.cursor) {
    args.push(page.cursor.createdAt, page.cursor.id);
    conds.push(`(created_at, id) < ($${args.length - 1}, $${args.length})`);
  }
  args.push(page.limit + 1);
  const rows = await query(ctx.deps.query,
    `SELECT ${cols} FROM ${table} WHERE ${conds.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${args.length}`, args);
  const paged = pageResult(rows.rows, page.limit, (row) => ({ createdAt: row.created_at, id: String(row.id) }));
  return pageBody(paged.items.map(dto), paged.nextCursor, paged.hasMore, ctx.rid);
};

const loadApp = async (ctx: Ctx, id: string): Promise<Row> => {
  const row = await one(ctx.deps.query, `SELECT ${APP_SELECT} FROM applications WHERE id = $1 AND user_id = $2`, [id, ctx.user.id]);
  if (!row) throw notFound();
  return row;
};

const loadJob = async (ctx: Ctx, jobId: string): Promise<Row> => {
  const row = await one(ctx.deps.query, "SELECT company, title FROM jobs WHERE id = $1 AND user_id = $2", [jobId, ctx.user.id]);
  if (!row) throw notFound();
  return row;
};

const failedUpdate = async (ctx: Ctx, table: string, id: string): Promise<never> => {
  const current = await one(ctx.deps.query, `SELECT revision FROM ${table} WHERE id = $1 AND user_id = $2`, [id, ctx.user.id]);
  if (!current) throw notFound();
  throw conflict(current.revision);
};

export const listApplications = async (ctx: Ctx): Promise<Response> => {
  const page = pageOf(ctx.url);
  const stage = ctx.url.searchParams.get("stage") || null;
  if (stage !== null && !validStage(stage)) throw fieldError("stage", "unsupported stage");
  const where = ["user_id = $1"];
  const params: unknown[] = [ctx.user.id];
  if (stage) {
    params.push(stage);
    where.push(`stage = $${params.length}`);
  }
  const q = ctx.url.searchParams.get("query") || "";
  if (q) {
    params.push("%" + q + "%", "%" + q + "%");
    where.push(`(company ILIKE $${params.length - 1} OR title ILIKE $${params.length})`);
  }
  return listPage(ctx, APP_SELECT, "applications", where, params, page, appDto);
};

export const getApplication = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  return data(200, appDto(await loadApp(ctx, id)), ctx.rid);
};

export const createApplication = async (ctx: Ctx): Promise<Response> => {
  const { values } = await strictBody(ctx.request, { jobId: { kind: "uuid", required: true }, notes: { kind: "str" } });
  const jobId = String(values.jobId);
  const job = await loadJob(ctx, jobId);
  const now = ts(ctx.now);
  const row: Row = {
    id: crypto.randomUUID(), revision: 1, job_id: jobId, company: job.company, title: job.title,
    stage: "DISCOVERED", notes: String(values.notes ?? ""), applied_at: null, next_action_at: null,
    imported: false, created_at: now, updated_at: now,
  };
  await query(ctx.deps.query,
    `INSERT INTO applications (${APP_COLS}) VALUES ($1,$2,1,$3,$4,$5,'DISCOVERED',$6,NULL,NULL,false,$7,$7)`,
    [row.id, ctx.user.id, jobId, row.company, row.title, row.notes, now]);
  return data(201, appDto(row), ctx.rid);
};

export const importApplication = async (ctx: Ctx): Promise<Response> => {
  const { values } = await strictBody(ctx.request, {
    jobId: { kind: "uuid", required: true },
    stage: { kind: "str", required: true },
    appliedAt: { kind: "str", required: true },
    notes: { kind: "str" },
    confirmed: { kind: "bool" },
  });
  const appliedAt = parseTimeField(values.appliedAt, "appliedAt");
  if (values.confirmed !== true) throw fieldError("confirmed", "must be true to record a past application");
  const stage = String(values.stage);
  if (!validStage(stage) || stage === "DISCOVERED") throw fieldError("stage", "unsupported stage for import");
  const jobId = String(values.jobId);
  const job = await loadJob(ctx, jobId);
  const now = ts(ctx.now);
  const row: Row = {
    id: crypto.randomUUID(), revision: 1, job_id: jobId, company: job.company, title: job.title, stage,
    notes: String(values.notes ?? ""), applied_at: appliedAt, next_action_at: null, imported: true,
    created_at: now, updated_at: now,
  };
  await query(ctx.deps.query,
    `WITH app AS (INSERT INTO applications (${APP_COLS}) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,NULL,true,$9,$9) RETURNING id)
     INSERT INTO application_events (${EVENT_COLS}) SELECT $10, $2, app.id, 'IMPORTED', $11::jsonb, $9 FROM app`,
    [row.id, ctx.user.id, jobId, row.company, row.title, stage, row.notes, appliedAt, now,
      crypto.randomUUID(), JSON.stringify({ stage, appliedAt })]);
  return data(201, appDto(row), ctx.rid);
};

export const patchApplication = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values, present } = await strictBody(ctx.request, {
    expectedRevision: { kind: "int", required: true },
    stage: { kind: "str", nullable: true },
    notes: { kind: "str", nullable: true },
    nextActionAt: { kind: "str", nullable: true },
  });
  let nextAt: string | null = null;
  let clearNext = false;
  if (present.has("nextActionAt")) {
    if (values.nextActionAt === null) clearNext = true;
    else nextAt = parseTimeField(values.nextActionAt, "nextActionAt");
  }
  const expected = Number(values.expectedRevision);
  const app = await loadApp(ctx, id);
  if (Number(app.revision) !== expected) throw conflict(app.revision);
  const now = ts(ctx.now);
  let event: { from: string; to: string } | null = null;
  if (values.stage != null) {
    const to = String(values.stage);
    const from = String(app.stage);
    if (!validStage(to)) throw fieldError("stage", "unsupported stage");
    if (to === "APPLIED" && from !== "APPLIED") throw transition("APPLIED can only be reached through submissions");
    if (!canPatchStage(from, to)) throw transition(`cannot move from ${from} to ${to}`);
    if (to !== from) {
      app.stage = to;
      if (to === "APPLIED") app.applied_at = now;
      event = { from, to };
    }
  }
  if (values.notes != null) app.notes = values.notes;
  if (clearNext) app.next_action_at = null;
  else if (nextAt !== null) app.next_action_at = nextAt;
  app.updated_at = now;
  const updated = await one(ctx.deps.query,
    `WITH upd AS (UPDATE applications SET revision = revision + 1, stage = $3, notes = $4, applied_at = $5, next_action_at = $6, imported = $7, updated_at = $8
       WHERE id = $1 AND user_id = $2 AND revision = $9 RETURNING id),
     ev AS (INSERT INTO application_events (${EVENT_COLS}) SELECT $10, $2, upd.id, 'STAGE_CHANGED', $11::jsonb, $8 FROM upd WHERE $12)
     SELECT id FROM upd`,
    [id, ctx.user.id, app.stage, app.notes, app.applied_at == null ? null : ts(app.applied_at),
      app.next_action_at == null ? null : ts(app.next_action_at), Boolean(app.imported), now, expected,
      crypto.randomUUID(), JSON.stringify(event ?? {}), event !== null]);
  if (!updated) await failedUpdate(ctx, "applications", id);
  app.revision = expected + 1;
  return data(200, appDto(app), ctx.rid);
};

export const applicationTimeline = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const page = pageOf(ctx.url);
  await loadApp(ctx, id);
  return listPage(ctx, EVENT_COLS, "application_events", ["user_id = $1", "application_id = $2"], [ctx.user.id, id], page, eventDto);
};

export const applicationChecklist = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const app = await loadApp(ctx, id);
  const counts = await one(ctx.deps.query,
    `SELECT (SELECT count(*) FROM career_evidence WHERE user_id = $1 AND NOT archived) AS evidence,
       (SELECT count(*) FROM gap_analyses WHERE user_id = $1 AND application_id = $2) AS analyses,
       (SELECT count(*) FROM documents WHERE user_id = $1 AND application_id = $2 AND status = 'FINALIZED') AS documents,
       (SELECT count(*) FROM interviews WHERE user_id = $1 AND application_id = $2) AS interviews`,
    [ctx.user.id, id]);
  const stage = String(app.stage);
  const applied = app.applied_at != null || TERMINAL.has(stage) || stage === "APPLIED" || afterApplied(stage);
  return data(200, {
    items: [
      { key: "evidence", label: "Career evidence collected", completed: Number(counts?.evidence) > 0 },
      { key: "analysis", label: "Gap analysis completed", completed: Number(counts?.analyses) > 0 },
      { key: "document_finalized", label: "Document finalized", completed: Number(counts?.documents) > 0 },
      { key: "applied", label: "Application submitted", completed: applied },
      { key: "interview_prep", label: "Interview session scheduled", completed: Number(counts?.interviews) > 0 },
    ],
    automationEnabled: false,
  }, ctx.rid);
};

export const createSubmissionDraft = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const appId = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, {
    expectedRevision: { kind: "int", required: true },
    mode: { kind: "str", required: true },
    adapter: { kind: "str", nullable: true },
    documentVersionIds: { kind: "uuid[]" },
    confirmedSubmitted: { kind: "bool" },
  });
  const app = await loadApp(ctx, appId);
  if (Number(app.revision) !== values.expectedRevision) throw conflict(app.revision);
  const mode = String(values.mode);
  const adapter = values.adapter == null ? null : String(values.adapter);
  if (mode !== MANUAL && mode !== ADAPTER) throw fieldError("mode", "must be MANUAL_RECORD or ADAPTER");
  if (mode === ADAPTER) throw new HttpError(403, "FEATURE_DISABLED", "adapter submission is not enabled for this site");
  if (adapter !== null) throw fieldError("adapter", "adapter is only valid with ADAPTER mode");
  const versionIds = uuids(values.documentVersionIds);
  if (!versionIds.length) throw fieldError("documentVersionIds", "at least one document version is required");
  for (const vid of versionIds) {
    const version = await one(ctx.deps.query,
      "SELECT v.application_id, d.finalized_version_id FROM document_versions v LEFT JOIN documents d ON d.id = v.document_id AND d.user_id = v.user_id WHERE v.id = $1 AND v.user_id = $2",
      [vid, ctx.user.id]);
    if (!version) throw fieldError("documentVersionIds", "version " + vid + " not found");
    if (String(version.application_id) !== appId) throw fieldError("documentVersionIds", "version " + vid + " belongs to another application");
    if (version.finalized_version_id == null || String(version.finalized_version_id) !== vid) {
      throw new HttpError(422, "DOCUMENT_NOT_FINALIZED", "document version " + vid + " is not finalized");
    }
  }
  const revision = Number(app.revision);
  const row: Row = {
    id: crypto.randomUUID(), application_id: appId, application_revision: revision, mode, adapter,
    document_version_ids: versionIds, confirmed_submitted: values.confirmedSubmitted === true,
    payload_hash: await hashJson({ applicationId: appId, applicationRevision: revision, mode, adapter, documentVersionIds: versionIds }),
    created_at: ts(ctx.now),
  };
  await query(ctx.deps.query,
    `INSERT INTO submission_drafts (${DRAFT_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
    [row.id, ctx.user.id, appId, revision, mode, adapter, JSON.stringify(versionIds), row.confirmed_submitted, row.payload_hash, row.created_at]);
  return data(201, draftDto(row), ctx.rid);
};

export const submitApplication = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const appId = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, {
    expectedRevision: { kind: "int", required: true },
    draftId: { kind: "uuid", required: true },
    approvalId: { kind: "uuid", required: true },
  });
  const expected = Number(values.expectedRevision);
  const approvalId = String(values.approvalId);
  const app = await loadApp(ctx, appId);
  if (Number(app.revision) !== expected) throw conflict(app.revision);
  const draft = await one(ctx.deps.query, `SELECT ${DRAFT_COLS} FROM submission_drafts WHERE id = $1 AND user_id = $2`, [values.draftId, ctx.user.id]);
  if (!draft) throw fieldError("draftId", "draft not found");
  if (String(draft.application_id) !== appId) throw fieldError("draftId", "draft belongs to another application");
  if (Number(draft.application_revision) !== Number(app.revision)) {
    throw approvalStale("application changed since the draft was created; create a new draft and approval");
  }
  const approval = await one(ctx.deps.query,
    "SELECT revision, kind, application_id, target_id, payload_hash, status, expires_at FROM approvals WHERE id = $1 AND user_id = $2",
    [approvalId, ctx.user.id]);
  if (!approval) throw approvalRequired("approval not found");
  if (approval.kind !== "APPLICATION_SUBMIT" || String(approval.application_id) !== appId || String(approval.target_id) !== String(draft.id)) {
    throw approvalRequired("approval does not cover this target");
  }
  if (approval.expires_at != null && ctx.now.getTime() > Date.parse(String(ts(approval.expires_at)))) throw approvalRequired("approval expired");
  if (approval.status !== "APPROVED") throw approvalRequired("approval is not approved");
  if (draft.payload_hash && approval.payload_hash !== draft.payload_hash) throw approvalStale("approved content has changed");
  if (draft.mode === MANUAL && !draft.confirmed_submitted) {
    throw fieldError("confirmedSubmitted", "manual submission requires confirming the external submission completed");
  }
  const stage = String(app.stage);
  if (TERMINAL.has(stage)) throw transition("application is closed");
  const move = stage !== "APPLIED" && !afterApplied(stage);
  const now = ts(ctx.now);
  const sub: Row = {
    id: crypto.randomUUID(), application_id: appId, mode: draft.mode, adapter: draft.adapter, status: "SUCCEEDED",
    document_version_ids: uuids(draft.document_version_ids), approval_id: approvalId, receipt_url: null, error_code: null,
    created_at: now, updated_at: now,
  };
  const done = await one(ctx.deps.query,
    `WITH ap AS (UPDATE approvals SET revision = revision + 1, status = 'CONSUMED', consumed_at = $3, updated_at = $3
       WHERE id = $1 AND user_id = $2 AND revision = $4
         AND EXISTS (SELECT 1 FROM applications WHERE id = $6 AND user_id = $2 AND revision = $10) RETURNING id),
     sub AS (INSERT INTO submissions (${SUB_COLS}) SELECT $5, $2, $6, $7, $8, 'SUCCEEDED', $9::jsonb, ap.id, NULL, NULL, $3, $3 FROM ap RETURNING id),
     app AS (UPDATE applications SET revision = revision + 1, stage = 'APPLIED', applied_at = $3, updated_at = $3
       FROM ap WHERE applications.id = $6 AND applications.user_id = $2 AND applications.revision = $10 AND $11 RETURNING applications.id),
     moved AS (INSERT INTO application_events (${EVENT_COLS}) SELECT $12, $2, app.id, 'STAGE_CHANGED', $13::jsonb, $3 FROM app),
     logged AS (INSERT INTO application_events (${EVENT_COLS}) SELECT $14, $2, $6, 'SUBMISSION', $15::jsonb, $3 FROM sub)
     SELECT ap.id FROM ap`,
    [approvalId, ctx.user.id, now, Number(approval.revision), sub.id, appId, sub.mode, sub.adapter,
      JSON.stringify(sub.document_version_ids), expected, move, crypto.randomUUID(),
      JSON.stringify({ from: stage, to: "APPLIED" }), crypto.randomUUID(),
      JSON.stringify({ submissionId: sub.id, mode: sub.mode, status: "SUCCEEDED" })]);
  if (!done) {
    const latest = await loadApp(ctx, appId);
    if (Number(latest.revision) !== expected) throw conflict(latest.revision);
    await failedUpdate(ctx, "approvals", approvalId);
  }
  return data(201, submissionDto(sub), ctx.rid);
};

export const listSubmissions = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const page = pageOf(ctx.url);
  await loadApp(ctx, id);
  return listPage(ctx, SUB_COLS, "submissions", ["user_id = $1", "application_id = $2"], [ctx.user.id, id], page, submissionDto);
};

export const dispatchApplications = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (path === "/api/v1/applications") {
    if (method === "GET") return listApplications(ctx);
    if (method === "POST") return createApplication(ctx);
    return null;
  }
  if (path === "/api/v1/applications/import") return method === "POST" ? importApplication(ctx) : null;
  const m = path.match(/^\/api\/v1\/applications\/([^/]+)(?:\/([a-z-]+))?$/);
  if (!m) return null;
  const [, id, sub] = m;
  if (!sub && method === "GET") return getApplication(ctx, id);
  if (!sub && method === "PATCH") return patchApplication(ctx, id);
  if (sub === "timeline" && method === "GET") return applicationTimeline(ctx, id);
  if (sub === "checklist" && method === "GET") return applicationChecklist(ctx, id);
  if (sub === "submission-drafts" && method === "POST") return createSubmissionDraft(ctx, id);
  if (sub === "submissions" && method === "POST") return submitApplication(ctx, id);
  if (sub === "submissions" && method === "GET") return listSubmissions(ctx, id);
  return null;
};
