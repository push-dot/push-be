import { strictBody, strictObject } from "../body.ts";
import { isMissingRelation, one, query } from "../db.ts";
import { searchFields } from "../hangul.ts";
import {
  blocksOf, codePointSlice, computeQuality, hunkEdits, qualityOf, replaced, validateDocumentContent,
  type Block,
} from "../document-content.ts";
import { HttpError, data, fieldError, hashJson, parseUuid, randomToken, requireUuid, sha256Hex } from "../http.ts";
import { enqueueIngest } from "../jobs/ingest.ts";
import { listPage, pageOf, ts } from "../page.ts";
import { httpsUrl, unprocessable } from "./recruiting-shared.ts";
import type { Ctx } from "../types.ts";

const DOC_COLS = "id, user_id, revision, application_id, title, kind, template, language, status, latest_version_id, finalized_version_id, created_at, updated_at";
const VERSION_COLS = "id, user_id, document_id, application_id, number, content, blocks, change_note, quality, created_at";
const PROPOSAL_COLS = "id, user_id, document_id, source_version_id, source_revision, selection, replacement, evidence_refs, claim_status, applied_at, created_at";
const EXPORT_COLS = "id, user_id, document_id, version_id, format, template, language, content, blocks, content_hash, status, renderer_version, result, created_at, updated_at";
const KINDS = new Set(["RESUME", "PORTFOLIO", "COVER_LETTER", "CAREER_STATEMENT", "HUB_PROFILE"]);
const TEMPLATE_ALIASES: Record<string, string> = { CLASSIC: "SIMPLE", COMPACT: "ATS" };
const TEMPLATES = new Set(["SIMPLE", "MODERN", "CREATIVE", "ATS", "CLASSIC", "COMPACT"]);
const TEMPLATE_MESSAGE = "must be SIMPLE, MODERN, CREATIVE, ATS, CLASSIC or COMPACT";

type Row = Record<string, unknown>;

const notFound = (): HttpError => new HttpError(404, "NOT_FOUND", "resource not found");
const conflict = (current: unknown): HttpError => new HttpError(409, "REVISION_CONFLICT", "resource was modified", { currentRevision: Number(current) });
const transition = (message: string): HttpError => new HttpError(409, "INVALID_TRANSITION", message);
const approvalRequired = (message: string): HttpError => new HttpError(409, "APPROVAL_REQUIRED", message);
const approvalStale = (message: string): HttpError => new HttpError(409, "APPROVAL_STALE", message);
const len = (value: string): number => Array.from(value).length;
const str = (value: unknown): string | null => (value == null ? null : String(value));

const documentDto = (row: Row): Row => ({
  id: String(row.id),
  revision: Number(row.revision),
  applicationId: str(row.application_id),
  title: String(row.title),
  kind: String(row.kind),
  template: String(row.template),
  language: String(row.language ?? ""),
  status: String(row.status),
  latestVersionId: str(row.latest_version_id),
  finalizedVersionId: str(row.finalized_version_id),
  createdAt: ts(row.created_at),
  updatedAt: ts(row.updated_at),
});

const versionDto = (row: Row): Row => ({
  id: String(row.id),
  documentId: String(row.document_id),
  applicationId: str(row.application_id),
  number: Number(row.number),
  content: row.content,
  blocks: blocksOf(row.blocks),
  changeNote: String(row.change_note ?? ""),
  quality: qualityOf(row.quality),
  createdAt: ts(row.created_at),
});

const exportResultOf = (value: unknown): Row | null => {
  if (!value || typeof value !== "object") return null;
  const r = value as Row;
  const v = (r.validation && typeof r.validation === "object" ? r.validation : {}) as Row;
  const pageCount = r.pageCount ?? r.page_count;
  const errorCode = r.errorCode ?? r.error_code;
  return {
    sha256: String(r.sha256),
    byteLength: Number(r.byteLength ?? r.byte_length),
    ...(pageCount == null ? {} : { pageCount: Number(pageCount) }),
    validation: { koreanText: Boolean(v.koreanText ?? v.korean_text), links: Boolean(v.links), atsText: Boolean(v.atsText ?? v.ats_text) },
    ...(errorCode == null ? {} : { errorCode: String(errorCode) }),
  };
};

const exportDto = (row: Row): Row => ({
  id: String(row.id),
  documentId: String(row.document_id),
  versionId: String(row.version_id),
  format: String(row.format),
  template: String(row.template),
  language: String(row.language ?? ""),
  content: row.content,
  blocks: blocksOf(row.blocks),
  contentHash: String(row.content_hash),
  status: String(row.status),
  rendererVersion: String(row.renderer_version),
  result: exportResultOf(row.result),
  createdAt: ts(row.created_at),
  updatedAt: ts(row.updated_at),
});


const loadDocument = async (ctx: Ctx, id: string): Promise<Row> => {
  const row = await one(ctx.deps.query, `SELECT ${DOC_COLS} FROM documents WHERE id = $1 AND user_id = $2`, [id, ctx.user.id]);
  if (!row) throw notFound();
  return row;
};

/** `_get_mutable`: archived documents take no writes. */
const loadMutable = async (ctx: Ctx, id: string): Promise<Row> => {
  const row = await loadDocument(ctx, id);
  if (row.status === "ARCHIVED") throw transition("document is archived");
  return row;
};

const loadVersion = async (ctx: Ctx, docId: string, versionId: string): Promise<Row> => {
  const row = await one(ctx.deps.query, `SELECT ${VERSION_COLS} FROM document_versions WHERE id = $1 AND user_id = $2 AND document_id = $3`,
    [versionId, ctx.user.id, docId]);
  if (!row) throw notFound();
  return row;
};

const failedUpdate = async (ctx: Ctx, table: string, id: string): Promise<never> => {
  const current = await one(ctx.deps.query, `SELECT revision FROM ${table} WHERE id = $1 AND user_id = $2`, [id, ctx.user.id]);
  if (!current) throw notFound();
  throw conflict(current.revision);
};

/** `_verify_blocks`: sets each block's claim status; returns evidence ids in first-seen order. */
const verifyBlocks = async (ctx: Ctx, blocks: Block[]): Promise<string[]> => {
  const wanted = [...new Set(blocks.flatMap((b) => b.evidenceRefs.map((ref) => ref.evidenceId)))];
  const rows = wanted.length
    ? (await query(ctx.deps.query,
      "SELECT id, source_text, archived FROM career_evidence WHERE user_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb)::uuid)",
      [ctx.user.id, JSON.stringify(wanted)])).rows
    : [];
  const evidence = new Map(rows.map((row) => [String(row.id), row]));
  const seen = new Set<string>();
  for (const b of blocks) {
    if (!b.evidenceRefs.length) {
      b.claimStatus = "UNSUPPORTED";
      continue;
    }
    let status = "SUPPORTED";
    for (const ref of b.evidenceRefs) {
      const e = evidence.get(ref.evidenceId);
      if (!e) throw fieldError("blocks", "evidence " + ref.evidenceId + " not found");
      seen.add(ref.evidenceId);
      if (e.archived) throw fieldError("blocks", "evidence " + ref.evidenceId + " is archived");
      const span = codePointSlice(String(e.source_text), ref.start, ref.end);
      if (span === null) throw fieldError("blocks", "evidenceRef range out of bounds for " + ref.evidenceId);
      if (!span || !b.text.includes(span)) status = "NEEDS_REVIEW";
    }
    b.claimStatus = status;
  }
  return [...seen];
};

/**
 * `_save_edit` / `create_version`: validate, verify, then write the version and move the
 * document to it in one statement, guarded by the document revision.
 */
const saveVersion = async (
  ctx: Ctx, doc: Row, expected: number, content: unknown, blocks: Block[], note: string,
  extra?: { proposalId: string },
): Promise<{ document: Row; version: Row }> => {
  validateDocumentContent(content, blocks);
  await verifyBlocks(ctx, blocks);
  const quality = computeQuality(blocks);
  const now = ts(ctx.now);
  const versionId = crypto.randomUUID();
  const docId = String(doc.id);
  const saved = await one(ctx.deps.query,
    `WITH upd AS (UPDATE documents SET revision = revision + 1, latest_version_id = $3, finalized_version_id = NULL,
         status = CASE WHEN status = 'FINALIZED' THEN 'DRAFT' ELSE status END, updated_at = $4
       WHERE id = $1 AND user_id = $2 AND revision = $5 RETURNING id),
     ins AS (INSERT INTO document_versions (${VERSION_COLS})
       SELECT $3, $2, $1, $6, (SELECT COALESCE(MAX(number), 0) + 1 FROM document_versions WHERE document_id = $1), $7::jsonb, $8::jsonb, $9, $10::jsonb, $4
       FROM upd RETURNING number),
     used AS (UPDATE revision_proposals SET applied_at = $4 FROM upd WHERE revision_proposals.id = $11 AND revision_proposals.user_id = $2 AND $11::uuid IS NOT NULL)
     SELECT number FROM ins`,
    [docId, ctx.user.id, versionId, now, expected, doc.application_id ?? null, JSON.stringify(content), JSON.stringify(blocks),
      note, JSON.stringify(quality), extra?.proposalId ?? null]);
  if (!saved) await failedUpdate(ctx, "documents", docId);
  await enqueueIngest(ctx, { documentId: docId });
  const document = {
    ...doc, revision: expected + 1, latest_version_id: versionId, finalized_version_id: null,
    status: doc.status === "FINALIZED" ? "DRAFT" : doc.status, updated_at: now,
  };
  const version = {
    id: versionId, document_id: docId, application_id: doc.application_id ?? null, number: Number(saved?.number),
    content, blocks, change_note: note, quality, created_at: now,
  };
  return { document: documentDto(document), version: versionDto(version) };
};

const blockInputs = (value: unknown): Block[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  return value.map((raw) => {
    const b = strictObject(raw, { id: { kind: "str", required: true }, text: { kind: "str", required: true }, evidenceRefs: { kind: "any" } }).values;
    const refs = b.evidenceRefs === undefined ? [] : b.evidenceRefs;
    if (!Array.isArray(refs)) throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
    return {
      id: String(b.id),
      text: String(b.text),
      evidenceRefs: refs.map((r) => {
        const ref = strictObject(r, { evidenceId: { kind: "uuid", required: true }, start: { kind: "int", required: true }, end: { kind: "int", required: true } }).values;
        return { evidenceId: String(ref.evidenceId), start: Number(ref.start), end: Number(ref.end) };
      }),
      claimStatus: "",
    };
  });
};

export const listDocuments = async (ctx: Ctx): Promise<Response> => {
  const page = pageOf(ctx.url);
  const appRaw = ctx.url.searchParams.get("applicationId");
  let applicationId: string | null = null;
  if (appRaw) {
    applicationId = parseUuid(appRaw);
    if (!applicationId) throw fieldError("applicationId", "must be a UUID");
  }
  const kind = ctx.url.searchParams.get("kind") || null;
  if (kind !== null && !KINDS.has(kind)) throw fieldError("kind", "unsupported kind");
  const where = ["user_id = $1", "status <> 'ARCHIVED'"];
  const params: unknown[] = [ctx.user.id];
  for (const [value, column] of [[applicationId, "application_id"], [kind, "kind"]] as const) {
    if (value === null) continue;
    params.push(value);
    where.push(`${column} = $${params.length}`);
  }
  return listPage(ctx.deps.query, ctx.rid, DOC_COLS, "documents", where, params, page, documentDto);
};

export const createDocument = async (ctx: Ctx): Promise<Response> => {
  const { values } = await strictBody(ctx.request, {
    applicationId: { kind: "uuid", required: true },
    title: { kind: "str", required: true },
    kind: { kind: "str", required: true },
    template: { kind: "str" },
    language: { kind: "str", required: true },
  });
  const app = await one(ctx.deps.query, "SELECT id FROM applications WHERE id = $1 AND user_id = $2", [values.applicationId, ctx.user.id]);
  if (!app) throw notFound();
  const title = String(values.title);
  const kind = String(values.kind);
  const template = String(values.template ?? "");
  if (len(title) < 1 || len(title) > 300) throw fieldError("title", "title must be 1-300 characters");
  if (!KINDS.has(kind)) throw fieldError("kind", "must be RESUME, PORTFOLIO, COVER_LETTER, CAREER_STATEMENT or HUB_PROFILE");
  if (!TEMPLATES.has(template)) throw fieldError("template", TEMPLATE_MESSAGE);
  const now = ts(ctx.now);
  const row: Row = {
    id: crypto.randomUUID(), revision: 1, application_id: values.applicationId, title, kind,
    template: TEMPLATE_ALIASES[template] ?? template, language: String(values.language), status: "DRAFT",
    latest_version_id: null, finalized_version_id: null, created_at: now, updated_at: now,
  };
  await query(ctx.deps.query,
    `INSERT INTO documents (${DOC_COLS}) VALUES ($1,$2,1,$3,$4,$5,$6,$7,'DRAFT',NULL,NULL,$8,$8)`,
    [row.id, ctx.user.id, row.application_id, title, kind, row.template, row.language, now]);
  return data(201, documentDto(row), ctx.rid);
};

export const getDocument = async (ctx: Ctx, idRaw: string): Promise<Response> =>
  data(200, documentDto(await loadDocument(ctx, requireUuid(idRaw, "id"))), ctx.rid);

export const patchDocument = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, {
    expectedRevision: { kind: "int", required: true },
    title: { kind: "str", nullable: true },
    template: { kind: "str", nullable: true },
    language: { kind: "str", nullable: true },
  });
  const expected = Number(values.expectedRevision);
  const doc = await loadMutable(ctx, id);
  if (Number(doc.revision) !== expected) throw conflict(doc.revision);
  if (values.title != null) {
    if (len(String(values.title)) < 1 || len(String(values.title)) > 300) throw fieldError("title", "title must be 1-300 characters");
    doc.title = values.title;
  }
  if (values.template != null) {
    const template = String(values.template);
    if (!TEMPLATES.has(template)) throw fieldError("template", TEMPLATE_MESSAGE);
    const stored = TEMPLATE_ALIASES[template] ?? template;
    if (stored !== doc.template) {
      doc.template = stored;
      doc.finalized_version_id = null;
      if (doc.status === "FINALIZED") doc.status = "DRAFT";
    }
  }
  if (values.language != null) doc.language = values.language;
  const now = ts(ctx.now);
  const updated = await one(ctx.deps.query,
    "UPDATE documents SET revision = revision + 1, title = $3, template = $4, language = $5, status = $6, latest_version_id = $7, finalized_version_id = $8, updated_at = $9 WHERE id = $1 AND user_id = $2 AND revision = $10 RETURNING id",
    [id, ctx.user.id, doc.title, doc.template, doc.language, doc.status, doc.latest_version_id ?? null, doc.finalized_version_id ?? null, now, expected]);
  if (!updated) await failedUpdate(ctx, "documents", id);
  return data(200, documentDto({ ...doc, revision: expected + 1, updated_at: now }), ctx.rid);
};

export const listVersions = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const page = pageOf(ctx.url);
  await loadDocument(ctx, id);
  return listPage(ctx.deps.query, ctx.rid, VERSION_COLS, "document_versions", ["user_id = $1", "document_id = $2"], [ctx.user.id, id], page, versionDto);
};

export const getVersion = async (ctx: Ctx, idRaw: string, versionRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const versionId = requireUuid(versionRaw, "versionId");
  await loadDocument(ctx, id);
  return data(200, versionDto(await loadVersion(ctx, id, versionId)), ctx.rid);
};

export const createVersion = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, {
    expectedRevision: { kind: "int", required: true },
    content: { kind: "object", required: true },
    blocks: { kind: "any" },
    changeNote: { kind: "str" },
  });
  const blocks = blockInputs(values.blocks);
  const expected = Number(values.expectedRevision);
  const doc = await loadMutable(ctx, id);
  if (Number(doc.revision) !== expected) throw conflict(doc.revision);
  return data(201, await saveVersion(ctx, doc, expected, values.content, blocks, String(values.changeNote ?? "")), ctx.rid);
};

export const applyRevision = async (ctx: Ctx, idRaw: string, proposalRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const proposalId = requireUuid(proposalRaw, "revisionId");
  const { values } = await strictBody(ctx.request, { expectedRevision: { kind: "int", required: true } });
  const expected = Number(values.expectedRevision);
  const doc = await loadMutable(ctx, id);
  if (Number(doc.revision) !== expected) throw conflict(doc.revision);
  const proposal = await one(ctx.deps.query, `SELECT ${PROPOSAL_COLS} FROM revision_proposals WHERE id = $1 AND user_id = $2 AND document_id = $3`,
    [proposalId, ctx.user.id, id]);
  if (!proposal) throw notFound();
  if (proposal.applied_at != null) throw transition("proposal already applied");
  if (doc.latest_version_id == null || String(doc.latest_version_id) !== String(proposal.source_version_id) || Number(proposal.source_revision) !== Number(doc.revision)) {
    throw approvalStale("document changed since the proposal was created");
  }
  const src = await loadVersion(ctx, id, String(proposal.source_version_id));
  const selection = (proposal.selection ?? {}) as Row;
  const edit = replaced(src.content, blocksOf(src.blocks), [[String(selection.text ?? ""), String(proposal.replacement)]]);
  if (!edit.applied) throw approvalStale("selection text no longer present in the version");
  return data(200, await saveVersion(ctx, doc, expected, edit.content, edit.blocks, "applied proposal " + proposalId, { proposalId }), ctx.rid);
};

/** Chat edits (the harness `edit_document` tool): `DocumentService.apply_hunks`. */
export const applyEdits = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  let body: Row;
  try { body = JSON.parse(await ctx.request.text()) as Row; } catch { throw new HttpError(400, "VALIDATION_ERROR", "invalid request body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  const edits = hunkEdits(Array.isArray(body.hunks) ? body.hunks : []);
  const doc = await loadMutable(ctx, id);
  const expectedVersion = body.revisionId ? String(body.revisionId) : "";
  if (doc.latest_version_id == null || (expectedVersion && expectedVersion !== String(doc.latest_version_id))) throw conflict(doc.revision);
  const src = await loadVersion(ctx, id, String(doc.latest_version_id));
  const edit = replaced(src.content, blocksOf(src.blocks), edits);
  if (!edit.applied) throw conflict(doc.revision);
  return data(200, await saveVersion(ctx, doc, Number(doc.revision), edit.content, edit.blocks, "applied chat edit"), ctx.rid);
};

export const reviewDocument = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, { versionId: { kind: "uuid", required: true } });
  await loadDocument(ctx, id);
  const version = await loadVersion(ctx, id, String(values.versionId));
  const blocks = blocksOf(version.blocks);
  await verifyBlocks(ctx, blocks);
  return data(200, { quality: computeQuality(blocks), blocks }, ctx.rid);
};

export const finalizeDocument = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, {
    expectedRevision: { kind: "int", required: true },
    versionId: { kind: "uuid", required: true },
    approvalId: { kind: "uuid", required: true },
  });
  const expected = Number(values.expectedRevision);
  const versionId = String(values.versionId);
  const approvalId = String(values.approvalId);
  const doc = await loadMutable(ctx, id);
  if (Number(doc.revision) !== expected) throw conflict(doc.revision);
  const version = await loadVersion(ctx, id, versionId);
  const blocks = blocksOf(version.blocks);
  const evidenceIds = await verifyBlocks(ctx, blocks);
  for (const b of blocks) if (b.claimStatus !== "SUPPORTED") throw new HttpError(409, "UNSUPPORTED_CLAIM", "block " + b.id + " is " + b.claimStatus);
  const appId = doc.application_id == null ? null : String(doc.application_id);
  const uses = evidenceIds.length
    ? (await query(ctx.deps.query,
      "SELECT DISTINCT ON (target_id) target_id, status FROM approvals WHERE user_id = $1 AND kind = 'EVIDENCE_USE' AND application_id IS NOT DISTINCT FROM $2::uuid AND target_id IN (SELECT jsonb_array_elements_text($3::jsonb)::uuid) AND status IN ('APPROVED','PENDING') AND (expires_at IS NULL OR expires_at > $4) ORDER BY target_id, created_at DESC",
      [ctx.user.id, appId, JSON.stringify(evidenceIds), ts(ctx.now)])).rows
    : [];
  const latestUse = new Map(uses.map((row) => [String(row.target_id), String(row.status)]));
  const unapproved = evidenceIds.find((eid) => latestUse.get(eid) !== "APPROVED");
  if (unapproved) throw approvalRequired("EVIDENCE_USE approval required for evidence " + unapproved);
  const approval = await one(ctx.deps.query,
    "SELECT revision, kind, application_id, target_id, payload_hash, status, expires_at FROM approvals WHERE id = $1 AND user_id = $2",
    [approvalId, ctx.user.id]);
  if (!approval) throw approvalRequired("approval not found");
  if (approval.kind !== "DOCUMENT_FINALIZE" || str(approval.application_id) !== appId || String(approval.target_id) !== versionId) {
    throw approvalRequired("approval does not cover this target");
  }
  if (approval.expires_at != null && ctx.now.getTime() > Date.parse(String(ts(approval.expires_at)))) throw approvalRequired("approval expired");
  if (approval.status !== "APPROVED") throw approvalRequired("approval is not approved");
  const hash = await hashJson({ kind: "DOCUMENT_FINALIZE", versionId, content: version.content, blocks });
  if (approval.payload_hash !== hash) throw approvalStale("approved content has changed");
  const now = ts(ctx.now);
  const done = await one(ctx.deps.query,
    `WITH ap AS (UPDATE approvals SET revision = revision + 1, status = 'CONSUMED', consumed_at = $3, updated_at = $3
       WHERE id = $1 AND user_id = $2 AND revision = $4
         AND EXISTS (SELECT 1 FROM documents WHERE id = $5 AND user_id = $2 AND revision = $6) RETURNING id),
     doc AS (UPDATE documents SET revision = revision + 1, status = 'FINALIZED', finalized_version_id = $7, updated_at = $3
       FROM ap WHERE documents.id = $5 AND documents.user_id = $2 AND documents.revision = $6 RETURNING documents.id),
     ev AS (INSERT INTO application_events (id, user_id, application_id, type, payload, created_at)
       SELECT $8, $2, $9::uuid, 'DOCUMENT_FINALIZED', $10::jsonb, $3 FROM doc WHERE $9::uuid IS NOT NULL)
     SELECT id FROM doc`,
    [approvalId, ctx.user.id, now, Number(approval.revision), id, expected, versionId, crypto.randomUUID(), appId,
      JSON.stringify({ documentId: id, versionId })]);
  if (!done) {
    const latest = await loadDocument(ctx, id);
    if (Number(latest.revision) !== expected) throw conflict(latest.revision);
    await failedUpdate(ctx, "approvals", approvalId);
  }
  return data(200, documentDto({ ...doc, revision: expected + 1, status: "FINALIZED", finalized_version_id: versionId, updated_at: now }), ctx.rid);
};

export const archiveDocument = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, { expectedRevision: { kind: "int", required: true } });
  const expected = Number(values.expectedRevision);
  const doc = await loadDocument(ctx, id);
  if (Number(doc.revision) !== expected) throw conflict(doc.revision);
  if (doc.status === "ARCHIVED") return data(200, documentDto(doc), ctx.rid);
  const now = ts(ctx.now);
  const updated = await one(ctx.deps.query,
    "UPDATE documents SET revision = revision + 1, status = 'ARCHIVED', updated_at = $3 WHERE id = $1 AND user_id = $2 AND revision = $4 RETURNING id",
    [id, ctx.user.id, now, expected]);
  if (!updated) await failedUpdate(ctx, "documents", id);
  return data(200, documentDto({ ...doc, revision: expected + 1, status: "ARCHIVED", updated_at: now }), ctx.rid);
};

export const createExport = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, {
    versionId: { kind: "uuid", required: true },
    format: { kind: "str", required: true },
    rendererVersion: { kind: "str", required: true },
  });
  const format = String(values.format);
  if (format !== "PDF" && format !== "DOCX") throw fieldError("format", "must be PDF or DOCX");
  if (!values.rendererVersion) throw fieldError("rendererVersion", "required");
  const doc = await loadDocument(ctx, id);
  const version = await loadVersion(ctx, id, String(values.versionId));
  const hubLatest = String(doc.kind) === "HUB_PROFILE"
    && doc.latest_version_id != null
    && String(doc.latest_version_id) === String(version.id);
  if (!hubLatest && (doc.finalized_version_id == null || String(doc.finalized_version_id) !== String(version.id))) {
    throw new HttpError(422, "DOCUMENT_NOT_FINALIZED", "only the finalized version can be exported");
  }
  const now = ts(ctx.now);
  const blocks = blocksOf(version.blocks);
  const row: Row = {
    id: crypto.randomUUID(), document_id: id, version_id: version.id, format, template: doc.template, language: doc.language ?? "",
    content: version.content, blocks, content_hash: await hashJson(version.content), status: "READY_TO_RENDER",
    renderer_version: values.rendererVersion, result: null, created_at: now, updated_at: now,
  };
  await query(ctx.deps.query,
    `INSERT INTO document_exports (${EXPORT_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,'READY_TO_RENDER',$11,NULL,$12,$12)`,
    [row.id, ctx.user.id, id, version.id, format, row.template, row.language, JSON.stringify(version.content), JSON.stringify(blocks),
      row.content_hash, row.renderer_version, now]);
  return data(201, exportDto(row), ctx.rid);
};

export const listExports = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const page = pageOf(ctx.url);
  await loadDocument(ctx, id);
  return listPage(ctx.deps.query, ctx.rid, EXPORT_COLS, "document_exports", ["user_id = $1", "document_id = $2"], [ctx.user.id, id], page, exportDto);
};

export const recordExportResult = async (ctx: Ctx, idRaw: string, exportRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const exportId = requireUuid(exportRaw, "exportId");
  const { values } = await strictBody(ctx.request, {
    sha256: { kind: "str", required: true },
    byteLength: { kind: "int", required: true },
    pageCount: { kind: "int", nullable: true },
    validation: { kind: "any" },
    status: { kind: "str", required: true },
    errorCode: { kind: "str", nullable: true },
  });
  const validation = values.validation === undefined ? {} : strictObject(values.validation, {
    koreanText: { kind: "bool" }, links: { kind: "bool" }, atsText: { kind: "bool" },
  }).values;
  const status = String(values.status);
  if (status !== "SUCCEEDED" && status !== "FAILED") throw fieldError("status", "must be SUCCEEDED or FAILED");
  if (!values.sha256 || Number(values.byteLength) < 0) throw fieldError("sha256", "sha256 and non-negative byteLength are required");
  const row = await one(ctx.deps.query, `SELECT ${EXPORT_COLS} FROM document_exports WHERE id = $1 AND user_id = $2 AND document_id = $3`,
    [exportId, ctx.user.id, id]);
  if (!row) throw notFound();
  if (row.status !== "READY_TO_RENDER") throw transition("export result already recorded");
  const result = exportResultOf({
    sha256: values.sha256, byteLength: values.byteLength, pageCount: values.pageCount ?? null,
    validation: { koreanText: validation.koreanText === true, links: validation.links === true, atsText: validation.atsText === true },
    errorCode: values.errorCode ?? null,
  });
  const now = ts(ctx.now);
  const recorded = await one(ctx.deps.query,
    "UPDATE document_exports SET status = $2, result = $3::jsonb, updated_at = $4 WHERE id = $1 AND user_id = $5 AND status = 'READY_TO_RENDER' RETURNING id",
    [exportId, status, JSON.stringify(result), now, ctx.user.id]);
  if (!recorded) throw transition("export result already recorded");
  return data(200, exportDto({ ...row, status, result, updated_at: now }), ctx.rid);
};

const clip = (value: string, max: number): string => {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

type DocNode = { type?: unknown; text?: unknown; content?: unknown };
type SectionName = "intro" | "careers" | "skills" | "links" | "headline" | "skip";

const nodeText = (node: DocNode): string => {
  const own = typeof node.text === "string" ? node.text : "";
  const nested = Array.isArray(node.content) ? node.content.map((child) => nodeText(child as DocNode)).join("") : "";
  return own + nested;
};

const sectionLines = (content: unknown): { heading: boolean; text: string }[] => {
  const lines: { heading: boolean; text: string }[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const typed = node as DocNode;
    const type = typeof typed.type === "string" ? typed.type : "";
    if (type === "heading" || type === "paragraph" || type === "listItem") {
      lines.push({ heading: type === "heading", text: nodeText(typed).trim() });
      return;
    }
    if (Array.isArray(typed.content)) for (const child of typed.content) visit(child);
  };
  visit(content);
  return lines;
};

const sectionName = (label: string): SectionName => {
  const key = label.trim().replace(/[:：]\s*$/, "").toLowerCase();
  if (key === "소개" || key === "intro") return "intro";
  if (key === "경력" || key === "careers" || key === "career") return "careers";
  if (key === "기술" || key === "기술 스택" || key === "skills" || key === "skill") return "skills";
  if (key === "링크" || key === "links" || key === "link") return "links";
  if (key === "한 줄" || key === "헤드라인" || key === "headline") return "headline";
  // shortcut: projects and education have no profile column, drop them until a migration adds one.
  return "skip";
};

const careerOf = (line: string): { company: string; role: string; startedOn: string | null; endedOn: string | null; description: string } | null => {
  const parts = line.split("|").map((part) => part.trim());
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return {
      company: clip(parts[0], 200),
      role: clip(parts[1], 200),
      startedOn: DATE.test(parts[2] ?? "") ? parts[2] : null,
      endedOn: DATE.test(parts[3] ?? "") ? parts[3] : null,
      description: clip(parts[4] ?? "", 500),
    };
  }
  const name = clip(line.trim(), 200);
  if (!name) return null;
  return { company: name, role: name, startedOn: null, endedOn: null, description: "" };
};

const linkKind = (url: string): string => {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return "other"; }
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (/(^|\.)((velog\.io)|(tistory\.com)|(medium\.com)|(blogspot\.com)|(brunch\.co\.kr))$/.test(host)) return "blog";
  if (/(^|\.)((notion\.site)|(notion\.so)|(behance\.net)|(dribbble\.com))$/.test(host)) return "portfolio";
  return "other";
};

const linkOf = (line: string): { id: string; kind: string; url: string; title: string } | null => {
  const parts = line.split("|").map((part) => part.trim()).filter(Boolean);
  const url = clip(parts.length >= 2 ? parts[parts.length - 1] : parts[0] ?? "", 2000);
  if (!httpsUrl(url)) return null;
  const title = parts.length >= 2 ? parts.slice(0, -1).join(" | ") : "";
  return { id: crypto.randomUUID(), kind: linkKind(url), url, title: clip(title, 300) };
};

const sectionsFrom = (content: unknown, blocks: unknown): { headline: string; intro: string; careers: unknown[]; skills: string[]; links: { id: string; kind: string; url: string; title: string }[]; replaceLinks: boolean; replaceCareers: boolean; replaceSkills: boolean; replaceIntro: boolean } => {
  const lines = sectionLines(content);
  const sawHeading = lines.some((line) => line.heading);
  const buckets: Record<Exclude<SectionName, "skip">, string[]> = { intro: [], careers: [], skills: [], links: [], headline: [] };
  let current: SectionName = "skip";
  let headed = false;
  for (const line of lines) {
    if (line.heading) {
      headed = true;
      current = sectionName(line.text);
      continue;
    }
    const text = line.text.replace(/^•\s*/, "").trim();
    if (!text) continue;
    if (!headed) buckets.intro.push(text);
    else if (current !== "skip") buckets[current].push(text);
  }
  const introLines = sawHeading ? buckets.intro : blocksOf(blocks).map((block) => block.text).filter(Boolean);
  const skills = buckets.skills.flatMap((line) => line.split(/[,·、]/)).map((item) => clip(item.trim(), 40)).filter(Boolean).slice(0, 50);
  return {
    headline: buckets.headline.join("\n"),
    intro: introLines.join("\n"),
    careers: buckets.careers.map(careerOf).filter((career) => career != null).slice(0, 30),
    skills,
    links: buckets.links.map(linkOf).filter((link) => link != null),
    replaceLinks: lines.some((line) => line.heading && sectionName(line.text) === "links"),
    replaceCareers: lines.some((line) => line.heading && sectionName(line.text) === "careers"),
    replaceSkills: lines.some((line) => line.heading && sectionName(line.text) === "skills"),
    replaceIntro: lines.some((line) => line.heading && sectionName(line.text) === "intro") || (!sawHeading && introLines.length > 0),
  };
};

const REPLACE_PROFILE = `WITH replaced AS (
  INSERT INTO profiles (user_id, headline, intro, careers, skills, search_text, search_choseong, search_jamo, created_at, updated_at)
  VALUES ($1::uuid, $2::text, $3::text, $4::jsonb, $5::jsonb, $6::text, $7::text, $8::text, $9::timestamptz, $9::timestamptz)
  ON CONFLICT (user_id) DO UPDATE SET
    headline = CASE WHEN $15::boolean THEN EXCLUDED.headline ELSE profiles.headline END,
    intro = CASE WHEN $14::boolean THEN EXCLUDED.intro ELSE profiles.intro END,
    careers = CASE WHEN $12::boolean THEN EXCLUDED.careers ELSE profiles.careers END,
    skills = CASE WHEN $13::boolean THEN EXCLUDED.skills ELSE profiles.skills END,
    search_text = EXCLUDED.search_text,
    search_choseong = EXCLUDED.search_choseong,
    search_jamo = EXCLUDED.search_jamo,
    updated_at = EXCLUDED.updated_at
  RETURNING user_id
), cleared AS (
  DELETE FROM user_links
  WHERE user_id = (SELECT user_id FROM replaced) AND $10::boolean
  RETURNING id
)
INSERT INTO user_links (id, user_id, kind, url, title, status, fit_count, ai_read, created_at)
SELECT link.id::uuid, replaced.user_id, link.kind, link.url, link.title, 'READ', 0, false, $9::timestamptz
FROM replaced
JOIN jsonb_to_recordset($11::jsonb) AS link(id text, kind text, url text, title text) ON $10::boolean`;

const profileSkills = async (ctx: Ctx): Promise<string[]> => {
  const current = await one(ctx.deps.query, "SELECT skills FROM profiles WHERE user_id = $1", [ctx.user.id]);
  return Array.isArray(current?.skills) ? current.skills.map(String) : [];
};

const PROFILE_SECTIONS = ["headline", "intro", "careers", "skills", "links"];

const sectionsOf = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw unprocessable("sections", "unsupported section");
  const out: string[] = [];
  for (const item of value) {
    if (!PROFILE_SECTIONS.includes(item)) throw unprocessable("sections", "unsupported section");
    if (!out.includes(item)) out.push(item);
  }
  return out;
};

const copyOntoBaseProfile = async (ctx: Ctx, doc: Row, id: string, sections: string[] | null): Promise<{ documentId: string; profileUserId: string; applied: string[] }> => {
  const nowIso = ctx.now.toISOString();
  const empty = { headline: "", intro: "", careers: [] as unknown[], skills: [] as string[], links: [] as { id: string; kind: string; url: string; title: string }[], replaceLinks: false, replaceCareers: false, replaceSkills: false, replaceIntro: false };
  const version = doc.latest_version_id == null ? null : await loadVersion(ctx, id, String(doc.latest_version_id));
  const parsed = version == null ? empty : sectionsFrom(version.content, version.blocks);
  const allow = (key: string): boolean => sections == null || sections.includes(key);
  const replaceLinks = parsed.replaceLinks && allow("links");
  const replaceCareers = parsed.replaceCareers && allow("careers");
  const replaceSkills = parsed.replaceSkills && allow("skills");
  const replaceIntro = parsed.replaceIntro && allow("intro");
  const replaceHeadline = allow("headline");
  const applied = PROFILE_SECTIONS.filter((key) => (
    key === "headline" ? replaceHeadline
      : key === "intro" ? replaceIntro
        : key === "careers" ? replaceCareers
          : key === "skills" ? replaceSkills
            : replaceLinks
  ));
  if (!applied.length) return { documentId: id, profileUserId: ctx.user.id, applied };
  const headline = clip(parsed.headline || String(doc.title), 120);
  const intro = clip(parsed.intro, 2000);
  const currentSkills = replaceSkills ? parsed.skills : await profileSkills(ctx);
  const fields = searchFields([ctx.user.displayName, headline, currentSkills.join(" ")].join(" "));
  await query(ctx.deps.query, REPLACE_PROFILE, [
    ctx.user.id, headline, intro, JSON.stringify(parsed.careers), JSON.stringify(parsed.skills),
    fields.text, fields.choseong, fields.jamo, nowIso, replaceLinks, JSON.stringify(parsed.links),
    replaceCareers, replaceSkills, replaceIntro, replaceHeadline,
  ]);
  return { documentId: id, profileUserId: ctx.user.id, applied };
};

const TEXT_SOURCE = new Set(["text/plain", "text/markdown"]);

const sourceText = (value: unknown): string => {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  if (typeof value !== "string" || value === "") return "";
  return Buffer.from(value, "base64").toString("utf8");
};

const mdToDoc = (md: string): { content: { type: "doc"; content: unknown[] }; blocks: Block[] } => {
  const nodes: unknown[] = [];
  const blocks: Block[] = [];
  const add = (kind: string, extra: Record<string, unknown>, text: string): void => {
    const bid = "block-" + (blocks.length + 1);
    nodes.push({ type: kind, attrs: { blockId: bid, ...extra }, content: [{ type: "text", text }] });
    blocks.push({ id: bid, text, evidenceRefs: [], claimStatus: "UNSUPPORTED" });
  };
  for (const raw of md.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line) continue;
    const heading = /^(#{1,4})\s+(.*)/.exec(line);
    const item = /^\s*[-*]\s+(.*)/.exec(line);
    if (heading) add("heading", { level: heading[1].length }, heading[2]);
    else if (item) add("paragraph", {}, "• " + item[1]);
    else add("paragraph", {}, line);
  }
  if (!nodes.length) add("paragraph", {}, "");
  return { content: { type: "doc", content: nodes }, blocks };
};

const insertProfileDocument = async (
  ctx: Ctx, title: string, version: { id: string; content: unknown; blocks: Block[] } | null,
): Promise<string> => {
  const now = ts(ctx.now);
  const docId = crypto.randomUUID();
  const versionId = version?.id ?? null;
  if (!version) {
    await query(ctx.deps.query,
      `INSERT INTO documents (${DOC_COLS}) VALUES ($1,$2,1,NULL,$3,$4,'SIMPLE','ko','DRAFT',NULL,NULL,$5,$5)`,
      [docId, ctx.user.id, title, "HUB_PROFILE", now]);
    return docId;
  }
  const quality = computeQuality(version.blocks);
  await query(ctx.deps.query,
    `WITH doc AS (
       INSERT INTO documents (${DOC_COLS}) VALUES ($1,$2,1,NULL,$3,$4,'SIMPLE','ko','DRAFT',$5,NULL,$6,$6)
       RETURNING id
     )
     INSERT INTO document_versions (${VERSION_COLS})
     SELECT $5, $2, doc.id, NULL, 1, $7::jsonb, $8::jsonb, 'source', $9::jsonb, $6 FROM doc`,
    [docId, ctx.user.id, title, "HUB_PROFILE", versionId, now, JSON.stringify(version.content), JSON.stringify(version.blocks), JSON.stringify(quality)]);
  return docId;
};

const convertOwnedSource = async (ctx: Ctx, id: string): Promise<Response> => {
  const source = await one(ctx.deps.query,
    "SELECT id, file_name, mime_type, content FROM sources WHERE id = $1 AND user_id = $2",
    [id, ctx.user.id]);
  if (!source) throw notFound();
  const title = clip(String(source.file_name || "프로필"), 300);
  const mime = String(source.mime_type || "");
  if (TEXT_SOURCE.has(mime)) {
    const built = mdToDoc(sourceText(source.content));
    const documentId = await insertProfileDocument(ctx, title, { id: crypto.randomUUID(), ...built });
    return data(200, { target: "application", documentId, applicationId: null }, ctx.rid);
  }
  const documentId = await insertProfileDocument(ctx, title, null);
  // shortcut: pdf/docx shell has no version until the ingest job finishes, fill inline when the worker is in this process
  const { jobId } = await enqueueIngest(ctx, { sourceId: id, profileDocumentId: documentId });
  return data(202, { target: "application", documentId, jobId, applicationId: null }, ctx.rid);
};

const convertHubDocument = async (
  ctx: Ctx, id: string, doc: Row, target: string, values: Record<string, unknown>, present: Set<string>,
): Promise<Response> => {
  if (String(doc.kind) !== "HUB_PROFILE") throw fieldError("kind", "only a hub profile document can be converted");
  if (target === "application") {
    if (!present.has("applicationId")) return data(200, { target, documentId: id, applicationId: null }, ctx.rid);
    if (!present.has("expectedRevision")) throw fieldError("expectedRevision", "required");
    const expected = Number(values.expectedRevision);
    if (Number(doc.revision) !== expected) throw conflict(doc.revision);
    const app = await one(ctx.deps.query, "SELECT id FROM applications WHERE id = $1 AND user_id = $2", [values.applicationId, ctx.user.id]);
    if (!app) throw notFound();
    const now = ts(ctx.now);
    const updated = await one(ctx.deps.query,
      "UPDATE documents SET application_id = $3, revision = revision + 1, updated_at = $4 WHERE id = $1 AND user_id = $2 AND revision = $5 RETURNING id",
      [id, ctx.user.id, values.applicationId, now, expected]);
    if (!updated) await failedUpdate(ctx, "documents", id);
    return data(200, { target, documentId: id, applicationId: String(values.applicationId) }, ctx.rid);
  }
  const copied = await copyOntoBaseProfile(ctx, doc, id, present.has("sections") ? sectionsOf(values.sections) : null);
  return data(200, { target, ...copied }, ctx.rid);
};

export const convertProfile = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values, present } = await strictBody(ctx.request, {
    target: { kind: "str" },
    applicationId: { kind: "uuid" },
    expectedRevision: { kind: "int" },
    sections: { kind: "any" },
  });
  const target = present.has("target") ? String(values.target) : "application";
  if (target !== "hub" && target !== "application") throw fieldError("target", "must be hub or application");
  if (present.has("sections") && target !== "hub") throw unprocessable("sections", "unsupported section");
  const doc = await one(ctx.deps.query, `SELECT ${DOC_COLS} FROM documents WHERE id = $1 AND user_id = $2`, [id, ctx.user.id]);
  if (doc) return convertHubDocument(ctx, id, doc, target, values, present);
  return convertOwnedSource(ctx, id);
};

export const setBaseProfile = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values, present } = await strictBody(ctx.request, { sections: { kind: "any" } });
  const doc = await loadDocument(ctx, id);
  if (String(doc.kind) !== "HUB_PROFILE") throw fieldError("kind", "only a hub profile document can be the base profile");
  return data(200, await copyOntoBaseProfile(ctx, doc, id, present.has("sections") ? sectionsOf(values.sections) : null), ctx.rid);
};

const sharingUnavailable = (): HttpError => new HttpError(404, "SHARING_UNAVAILABLE", "sharing unavailable");

const jsonValue = (value: unknown): unknown => {
  if (typeof value !== "string" || value === "") return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
};

const shareDocument = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const raw = await ctx.request.text();
  let versionId = "";
  if (raw.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new HttpError(400, "VALIDATION_ERROR", "invalid request body"); }
    const body = strictObject(parsed, { versionId: { kind: "uuid" } });
    if (body.present.has("versionId")) versionId = String(body.values.versionId);
  }
  const doc = await loadDocument(ctx, id);
  const pinned = versionId || (doc.latest_version_id == null ? "" : String(doc.latest_version_id));
  if (!pinned) throw notFound();
  await loadVersion(ctx, id, pinned);
  const token = randomToken();
  const now = ts(ctx.now);
  try {
    await query(ctx.deps.query,
      `WITH revoked AS (
         UPDATE document_shares SET revoked_at = $6::timestamptz
         WHERE document_id = $2::uuid AND revoked_at IS NULL
         RETURNING id
       )
       INSERT INTO document_shares (id, document_id, version_id, token_hash, created_by, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid, $6::timestamptz)`,
      [crypto.randomUUID(), id, pinned, await sha256Hex(token), ctx.user.id, now]);
  } catch (err) {
    if (isMissingRelation(err)) throw sharingUnavailable();
    throw err;
  }
  return data(200, { token, path: `/api/v1/documents/shared/${token}`, versionId: pinned, createdAt: now }, ctx.rid);
};

const revokeShare = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  await loadDocument(ctx, id);
  try {
    const row = await one(ctx.deps.query,
      `UPDATE document_shares SET revoked_at = $3::timestamptz
       WHERE document_id = $1::uuid AND created_by = $2::uuid AND revoked_at IS NULL
       RETURNING id`,
      [id, ctx.user.id, ts(ctx.now)]);
    return data(200, { revoked: Boolean(row) }, ctx.rid);
  } catch (err) {
    if (isMissingRelation(err)) throw sharingUnavailable();
    throw err;
  }
};

const readShare = async (ctx: Ctx, token: string): Promise<Response> => {
  let row: Row | null;
  try {
    row = await one(ctx.deps.query,
      `SELECT d.title, d.kind, v.content, v.blocks
       FROM document_shares s
       JOIN document_versions v ON v.id = s.version_id
       JOIN documents d ON d.id = s.document_id
       WHERE s.token_hash = $1::text AND s.revoked_at IS NULL AND d.status <> 'ARCHIVED'`,
      [await sha256Hex(token)]);
  } catch (err) {
    if (isMissingRelation(err)) throw sharingUnavailable();
    throw err;
  }
  if (!row) throw notFound();
  return data(200, {
    title: String(row.title ?? ""),
    kind: String(row.kind),
    content: jsonValue(row.content),
    blocks: blocksOf(jsonValue(row.blocks)),
  }, ctx.rid);
};

export const isDocumentEdit = (method: string, path: string): boolean =>
  method === "POST" && /^\/api\/v1\/documents\/[^/]+\/edits$/.test(path);

export const dispatchDocuments = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (path === "/api/v1/documents") {
    if (method === "GET") return listDocuments(ctx);
    if (method === "POST") return createDocument(ctx);
    return null;
  }
  const versions = path.match(/^\/api\/v1\/documents\/([^/]+)\/versions(?:\/([^/]+))?$/);
  if (versions) {
    if (!versions[2] && method === "GET") return listVersions(ctx, versions[1]);
    if (!versions[2] && method === "POST") return createVersion(ctx, versions[1]);
    if (versions[2] && method === "GET") return getVersion(ctx, versions[1], versions[2]);
    return null;
  }
  const apply = path.match(/^\/api\/v1\/documents\/([^/]+)\/revisions\/([^/]+)\/apply$/);
  if (apply && method === "POST") return applyRevision(ctx, apply[1], apply[2]);
  const result = path.match(/^\/api\/v1\/documents\/([^/]+)\/exports\/([^/]+)\/result$/);
  if (result && method === "POST") return recordExportResult(ctx, result[1], result[2]);
  const shared = path.match(/^\/api\/v1\/documents\/shared\/([^/]+)$/);
  if (shared && method === "GET") return readShare(ctx, shared[1]);
  const share = path.match(/^\/api\/v1\/documents\/([^/]+)\/share$/);
  if (share && method === "POST") return shareDocument(ctx, share[1]);
  if (share && method === "DELETE") return revokeShare(ctx, share[1]);
  const baseProfile = path.match(/^\/api\/v1\/documents\/([^/]+)\/base-profile$/);
  if (baseProfile && method === "POST") return setBaseProfile(ctx, baseProfile[1]);
  const profile = path.match(/^\/api\/v1\/documents\/([^/]+)\/profile$/);
  if (profile && method === "POST") return convertProfile(ctx, profile[1]);
  const m = path.match(/^\/api\/v1\/documents\/([^/]+)(?:\/(edits|review|finalize|archive|exports))?$/);
  if (!m) return null;
  const [, id, sub] = m;
  if (!sub && method === "GET") return getDocument(ctx, id);
  if (!sub && method === "PATCH") return patchDocument(ctx, id);
  if (sub === "edits" && method === "POST") return applyEdits(ctx, id);
  if (sub === "review" && method === "POST") return reviewDocument(ctx, id);
  if (sub === "finalize" && method === "POST") return finalizeDocument(ctx, id);
  if (sub === "archive" && method === "POST") return archiveDocument(ctx, id);
  if (sub === "exports" && method === "GET") return listExports(ctx, id);
  if (sub === "exports" && method === "POST") return createExport(ctx, id);
  return null;
};
