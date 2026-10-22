import { parseTimeField, strictBody, strictObject } from "../body.ts";
import { one, query } from "../db.ts";
import { HttpError, data, fieldError, hashJson, pageBody, parseUuid, requireUuid, sha256Hex } from "../http.ts";
import { pageOf, pageResult, ts, type Page } from "../page.ts";
import type { Ctx } from "../types.ts";

const BP_COLS = "id, user_id, revision, application_id, gap_analysis_id, title, skills, problem, solution, tasks, completion_criteria, metrics, estimated_effort, state, created_at, updated_at";
const RUN_COLS = "id, user_id, revision, project_id, application_id, provider, working_directory, executable, arguments, prompt, payload_hash, state, launch_status, approval_id, device_id, detected_version, started_at, finished_at, failure_reason, exit_code, commit_sha, stdout_hash, stderr_hash, created_at, updated_at";
const PEV_COLS = "id, user_id, revision, project_id, run_id, commit_url, commit_sha, test_results, metrics, summary, status, verification_method, verified_at, career_evidence_id, created_at, updated_at";
const EXECUTABLES: Record<string, string> = { CODEX: "codex", CLAUDE_CODE: "claude", GROK_BUILD: "grok" };

type Row = Record<string, unknown>;

const notFound = (): HttpError => new HttpError(404, "NOT_FOUND", "resource not found");
const conflict = (current: unknown): HttpError => new HttpError(409, "REVISION_CONFLICT", "resource was modified", { currentRevision: Number(current) });
const transition = (message: string): HttpError => new HttpError(409, "INVALID_TRANSITION", message);
const approvalRequired = (message: string): HttpError => new HttpError(409, "APPROVAL_REQUIRED", message);
const approvalStale = (message: string): HttpError => new HttpError(409, "APPROVAL_STALE", message);

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const str = (value: unknown): string | null => (value == null ? null : String(value));
const num = (value: unknown): number | null => (value == null ? null : Number(value));
const field = (o: Row, camel: string, snake: string): unknown => (camel in o ? o[camel] : o[snake]);

const blueprintDto = (row: Row): Row => {
  const effort = obj(row.estimated_effort);
  return {
    id: String(row.id),
    revision: Number(row.revision),
    applicationId: String(row.application_id),
    gapAnalysisId: String(row.gap_analysis_id),
    title: String(row.title),
    skills: list(row.skills).map(String),
    problem: String(row.problem ?? ""),
    solution: String(row.solution ?? ""),
    tasks: list(row.tasks).map((t) => {
      const task = obj(t);
      return { id: String(task.id), title: String(task.title), description: String(task.description), acceptance: list(task.acceptance).map(String) };
    }),
    completionCriteria: list(row.completion_criteria).map(String),
    metrics: list(row.metrics).map((m) => {
      const metric = obj(m);
      return { name: String(metric.name), unit: String(metric.unit), measurement: String(metric.measurement), target: num(metric.target) };
    }),
    estimatedEffort: { minHours: Number(field(effort, "minHours", "min_hours") ?? 0), maxHours: Number(field(effort, "maxHours", "max_hours") ?? 0) },
    state: String(row.state),
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
  };
};

const runDto = (row: Row): Row => ({
  id: String(row.id),
  revision: Number(row.revision),
  projectId: String(row.project_id),
  applicationId: String(row.application_id),
  provider: String(row.provider),
  workingDirectory: String(row.working_directory),
  executable: String(row.executable),
  arguments: list(row.arguments).map(String),
  prompt: String(row.prompt),
  payloadHash: String(row.payload_hash),
  state: String(row.state),
  launchStatus: String(row.launch_status),
  approvalId: str(row.approval_id),
  deviceId: str(row.device_id),
  detectedVersion: str(row.detected_version),
  startedAt: ts(row.started_at),
  finishedAt: ts(row.finished_at),
  failureReason: str(row.failure_reason),
  exitCode: num(row.exit_code),
  commitSha: str(row.commit_sha),
  stdoutHash: str(row.stdout_hash),
  stderrHash: str(row.stderr_hash),
  createdAt: ts(row.created_at),
  updatedAt: ts(row.updated_at),
});

const evidenceDto = (row: Row): Row => {
  const results = obj(row.test_results);
  return {
    id: String(row.id),
    revision: Number(row.revision),
    projectId: String(row.project_id),
    runId: String(row.run_id),
    commitUrl: String(row.commit_url),
    commitSha: str(row.commit_sha),
    testResults: {
      testCommand: String(field(results, "testCommand", "test_command") ?? ""),
      testOutput: String(field(results, "testOutput", "test_output") ?? ""),
      exitCode: Number(field(results, "exitCode", "exit_code") ?? 0),
    },
    metrics: list(row.metrics).map((m) => {
      const metric = obj(m);
      return { name: String(metric.name), value: Number(metric.value), unit: String(metric.unit) };
    }),
    summary: String(row.summary ?? ""),
    status: String(row.status),
    verificationMethod: str(row.verification_method),
    verifiedAt: ts(row.verified_at),
    careerEvidenceId: str(row.career_evidence_id),
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
  };
};

const pageOfRows = async (ctx: Ctx, cols: string, table: string, where: string[], params: unknown[], page: Page, dto: (row: Row) => Row): Promise<Response> => {
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

const loadBlueprint = async (ctx: Ctx, id: string): Promise<Row> => {
  const row = await one(ctx.deps.query, `SELECT ${BP_COLS} FROM project_blueprints WHERE id = $1 AND user_id = $2`, [id, ctx.user.id]);
  if (!row) throw notFound();
  return row;
};

const loadRun = async (ctx: Ctx, projectId: string, runId: string): Promise<Row | null> =>
  one(ctx.deps.query, `SELECT ${RUN_COLS} FROM cli_runs WHERE id = $1 AND user_id = $2 AND project_id = $3`, [runId, ctx.user.id, projectId]);

const runFor = async (ctx: Ctx, projectId: string, runId: string, expected: number): Promise<Row> => {
  const run = await loadRun(ctx, projectId, runId);
  if (!run) throw notFound();
  if (Number(run.revision) !== expected) throw conflict(run.revision);
  return run;
};

const failedUpdate = async (ctx: Ctx, table: string, id: string): Promise<never> => {
  const current = await one(ctx.deps.query, `SELECT revision FROM ${table} WHERE id = $1 AND user_id = $2`, [id, ctx.user.id]);
  if (!current) throw notFound();
  throw conflict(current.revision);
};

/** `ProjectStore.update_run`: every mutable column, guarded by revision. */
const saveRun = async (ctx: Ctx, run: Row, expected: number): Promise<Row> => {
  const now = ts(ctx.now);
  const updated = await one(ctx.deps.query,
    "UPDATE cli_runs SET revision = revision + 1, state = $3, launch_status = $4, approval_id = $5, device_id = $6, detected_version = $7, started_at = $8, finished_at = $9, failure_reason = $10, exit_code = $11, commit_sha = $12, stdout_hash = $13, stderr_hash = $14, updated_at = $15 WHERE id = $1 AND user_id = $2 AND revision = $16 RETURNING id",
    [run.id, ctx.user.id, run.state, run.launch_status, run.approval_id ?? null, run.device_id ?? null, run.detected_version ?? null,
      run.started_at == null ? null : ts(run.started_at), run.finished_at == null ? null : ts(run.finished_at), run.failure_reason ?? null,
      run.exit_code ?? null, run.commit_sha ?? null, run.stdout_hash ?? null, run.stderr_hash ?? null, now, expected]);
  if (!updated) await failedUpdate(ctx, "cli_runs", String(run.id));
  return { ...run, revision: expected + 1, updated_at: now };
};

const processInfo = (value: unknown): { pid: number; startedAt: string } | null => {
  if (value === undefined || value === null) return null;
  const { values } = strictObject(value, { pid: { kind: "int", required: true }, startedAt: { kind: "str", required: true } });
  return { pid: Number(values.pid), startedAt: parseTimeField(values.startedAt, "process.startedAt") };
};

const manifest = async (row: Row): Promise<Row> => {
  const bp = blueprintDto(row);
  const readme = "# " + bp.title + "\n\n## Problem\n" + bp.problem + "\n\n## Solution\n" + bp.solution + "\n";
  let tasks = "";
  for (const task of bp.tasks as { title: string; description: string; acceptance: string[] }[]) {
    tasks += "## " + task.title + "\n" + task.description + "\n\nAcceptance:\n";
    for (const a of task.acceptance) tasks += "- " + a + "\n";
    tasks += "\n";
  }
  const files = [];
  for (const [path, content] of [["README.md", readme], ["docs/tasks.md", tasks]]) {
    files.push({ path, encoding: "utf8", content, sha256: await sha256Hex(content) });
  }
  return { projectId: bp.id, blueprintRevision: bp.revision, files };
};

export const listProjects = async (ctx: Ctx): Promise<Response> => {
  const appRaw = ctx.url.searchParams.get("applicationId");
  const params: unknown[] = [ctx.user.id];
  const where = ["user_id = $1"];
  if (appRaw) {
    const app = parseUuid(appRaw);
    if (!app) throw fieldError("applicationId", "must be a UUID");
    params.push(app);
    where.push(`application_id = $${params.length}`);
  }
  return pageOfRows(ctx, BP_COLS, "project_blueprints", where, params, pageOf(ctx.url), blueprintDto);
};

export const getProject = async (ctx: Ctx, idRaw: string): Promise<Response> =>
  data(200, blueprintDto(await loadBlueprint(ctx, requireUuid(idRaw, "id"))), ctx.rid);

export const selectProject = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, { expectedRevision: { kind: "int", required: true } });
  const expected = Number(values.expectedRevision);
  const bp = await loadBlueprint(ctx, id);
  if (Number(bp.revision) !== expected) throw conflict(bp.revision);
  if (bp.state !== "DRAFT" && bp.state !== "SELECTED") throw transition("blueprint cannot be selected from " + bp.state);
  const now = ts(ctx.now);
  const updated = await one(ctx.deps.query,
    "UPDATE project_blueprints SET revision = revision + 1, state = 'SELECTED', updated_at = $3 WHERE id = $1 AND user_id = $2 AND revision = $4 RETURNING id",
    [id, ctx.user.id, now, expected]);
  if (!updated) await failedUpdate(ctx, "project_blueprints", id);
  const next = { ...bp, state: "SELECTED", updated_at: now, revision: expected + 1 };
  return data(200, { blueprint: blueprintDto(next), manifest: await manifest(next) }, ctx.rid);
};

export const listRuns = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const page = pageOf(ctx.url);
  await loadBlueprint(ctx, id);
  return pageOfRows(ctx, RUN_COLS, "cli_runs", ["user_id = $1", "project_id = $2"], [ctx.user.id, id], page, runDto);
};

export const createRun = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const projectId = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, {
    provider: { kind: "str", required: true },
    workingDirectory: { kind: "str", required: true },
    prompt: { kind: "str", required: true },
  });
  const provider = String(values.provider);
  const dir = String(values.workingDirectory);
  const prompt = String(values.prompt);
  if (!(provider in EXECUTABLES)) throw fieldError("provider", "unsupported provider");
  if (!dir.startsWith("/")) throw fieldError("workingDirectory", "absolute path required");
  if (!prompt) throw fieldError("prompt", "required");
  const bp = await loadBlueprint(ctx, projectId);
  if (bp.state !== "SELECTED" && bp.state !== "IN_PROGRESS") throw transition("blueprint must be selected before creating a run");
  const executable = EXECUTABLES[provider];
  const now = ts(ctx.now);
  const run: Row = {
    id: crypto.randomUUID(), revision: 1, project_id: projectId, application_id: bp.application_id, provider,
    working_directory: dir, executable, arguments: [], prompt,
    payload_hash: await hashJson({ provider, workingDirectory: dir, executable, arguments: [], prompt }),
    state: "APPROVAL_REQUIRED", launch_status: "NOT_CLAIMED", created_at: now, updated_at: now,
  };
  const done = await one(ctx.deps.query,
    `WITH run AS (INSERT INTO cli_runs (${RUN_COLS}) VALUES ($1,$2,1,$3,$4,$5,$6,$7,'[]'::jsonb,$8,$9,'APPROVAL_REQUIRED','NOT_CLAIMED',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,$10,$10) RETURNING id),
     bp AS (UPDATE project_blueprints SET revision = revision + 1, state = 'IN_PROGRESS', updated_at = $10
       FROM run WHERE project_blueprints.id = $3 AND project_blueprints.user_id = $2 AND project_blueprints.state = 'SELECTED' AND project_blueprints.revision = $11 RETURNING project_blueprints.id)
     SELECT (SELECT count(*) FROM run)::int AS runs, (SELECT count(*) FROM bp)::int AS moved`,
    [run.id, ctx.user.id, projectId, bp.application_id, provider, dir, executable, prompt, run.payload_hash, now, Number(bp.revision)]);
  if (bp.state === "SELECTED" && Number(done?.moved) !== 1) await failedUpdate(ctx, "project_blueprints", projectId);
  return data(201, runDto(run), ctx.rid);
};

export const startRun = async (ctx: Ctx, projectRaw: string, runRaw: string): Promise<Response> => {
  const projectId = requireUuid(projectRaw, "id");
  const runId = requireUuid(runRaw, "runId");
  const { values } = await strictBody(ctx.request, {
    expectedRevision: { kind: "int", required: true },
    approvalId: { kind: "uuid", required: true },
    detectedVersion: { kind: "str", required: true },
    deviceId: { kind: "str", required: true },
  });
  if (!values.deviceId) throw fieldError("deviceId", "required");
  if (!values.detectedVersion) throw fieldError("detectedVersion", "required");
  const expected = Number(values.expectedRevision);
  const approvalId = String(values.approvalId);
  const run = await runFor(ctx, projectId, runId, expected);
  if (run.state !== "APPROVAL_REQUIRED") throw transition("run cannot start from " + run.state);
  const approval = await one(ctx.deps.query,
    "SELECT revision, kind, application_id, target_id, target_revision, payload_hash, status, expires_at FROM approvals WHERE id = $1 AND user_id = $2",
    [approvalId, ctx.user.id]);
  if (!approval) throw approvalRequired("approval not found");
  if (approval.kind !== "CLI_EXECUTE" || String(approval.application_id) !== String(run.application_id) || String(approval.target_id) !== runId) {
    throw approvalRequired("approval does not cover this target");
  }
  if (approval.expires_at != null && ctx.now.getTime() > Date.parse(String(ts(approval.expires_at)))) throw approvalRequired("approval expired");
  if (approval.status !== "APPROVED") throw approvalRequired("approval is not approved");
  if (run.payload_hash && approval.payload_hash !== run.payload_hash) throw approvalStale("approved content has changed");
  if (approval.target_revision != null && Number(approval.target_revision) !== Number(run.revision)) {
    throw approvalStale("approval was issued for a different run revision");
  }
  const now = ts(ctx.now);
  const done = await one(ctx.deps.query,
    `WITH ap AS (UPDATE approvals SET revision = revision + 1, status = 'CONSUMED', consumed_at = $3, updated_at = $3
       WHERE id = $1 AND user_id = $2 AND revision = $4
         AND EXISTS (SELECT 1 FROM cli_runs WHERE id = $5 AND user_id = $2 AND revision = $6) RETURNING id),
     run AS (UPDATE cli_runs SET revision = revision + 1, state = 'RUNNING', approval_id = ap.id, device_id = $7, detected_version = $8, started_at = $3, updated_at = $3
       FROM ap WHERE cli_runs.id = $5 AND cli_runs.user_id = $2 AND cli_runs.revision = $6 RETURNING cli_runs.id)
     SELECT id FROM run`,
    [approvalId, ctx.user.id, now, Number(approval.revision), runId, expected, values.deviceId, values.detectedVersion]);
  if (!done) {
    const latest = await loadRun(ctx, projectId, runId);
    if (latest && Number(latest.revision) !== expected) throw conflict(latest.revision);
    await failedUpdate(ctx, "approvals", approvalId);
  }
  return data(200, runDto({
    ...run, revision: expected + 1, state: "RUNNING", approval_id: approvalId, device_id: values.deviceId,
    detected_version: values.detectedVersion, started_at: now, updated_at: now,
  }), ctx.rid);
};

const LAUNCH_NEXT: Record<string, string[]> = { NOT_CLAIMED: ["CLAIMED"], CLAIMED: ["STARTED", "UNKNOWN"], STARTED: ["UNKNOWN"] };

export const reportLaunch = async (ctx: Ctx, projectRaw: string, runRaw: string): Promise<Response> => {
  const projectId = requireUuid(projectRaw, "id");
  const runId = requireUuid(runRaw, "runId");
  const { values } = await strictBody(ctx.request, {
    expectedRevision: { kind: "int", required: true },
    deviceId: { kind: "str", required: true },
    payloadHash: { kind: "str", required: true },
    launchStatus: { kind: "str", required: true },
    process: { kind: "any", nullable: true },
  });
  const process = processInfo(values.process);
  const status = String(values.launchStatus);
  if (!["CLAIMED", "STARTED", "UNKNOWN"].includes(status)) throw fieldError("launchStatus", "must be CLAIMED, STARTED or UNKNOWN");
  const expected = Number(values.expectedRevision);
  const run = await runFor(ctx, projectId, runId, expected);
  if (run.state !== "RUNNING") throw transition("run is not running");
  if (run.device_id == null || run.device_id !== values.deviceId) throw transition("run is bound to a different device");
  if (values.payloadHash !== run.payload_hash) throw approvalStale("payload hash does not match the approved run");
  if (status === "STARTED" && process === null) throw fieldError("process", "process info required for STARTED");
  const from = String(run.launch_status);
  if (from !== status && !(LAUNCH_NEXT[from] ?? []).includes(status)) {
    throw transition(`launchStatus cannot move from ${from} to ${status}`);
  }
  return data(200, runDto(await saveRun(ctx, { ...run, launch_status: status }, expected)), ctx.rid);
};

export const recoverRun = async (ctx: Ctx, projectRaw: string, runRaw: string): Promise<Response> => {
  const projectId = requireUuid(projectRaw, "id");
  const runId = requireUuid(runRaw, "runId");
  const { values } = await strictBody(ctx.request, {
    expectedRevision: { kind: "int", required: true },
    deviceId: { kind: "str", required: true },
    decision: { kind: "str", required: true },
    process: { kind: "any", nullable: true },
    failureReason: { kind: "str", nullable: true },
  });
  const process = processInfo(values.process);
  const decision = String(values.decision);
  if (decision !== "REATTACH" && decision !== "MARK_FAILED") throw fieldError("decision", "must be REATTACH or MARK_FAILED");
  const expected = Number(values.expectedRevision);
  const run = await runFor(ctx, projectId, runId, expected);
  if (run.launch_status !== "UNKNOWN") throw transition("recover is only allowed from UNKNOWN launch status");
  if (run.device_id == null || run.device_id !== values.deviceId) throw transition("run is bound to a different device");
  const next: Row = { ...run };
  if (decision === "REATTACH") {
    if (process === null || process.pid <= 0) throw fieldError("process", "process info required for REATTACH");
    next.launch_status = "STARTED";
  } else {
    if (!values.failureReason) throw fieldError("failureReason", "required for MARK_FAILED");
    Object.assign(next, { launch_status: "FINISHED", state: "FAILED", failure_reason: values.failureReason, finished_at: ts(ctx.now) });
  }
  return data(200, runDto(await saveRun(ctx, next, expected)), ctx.rid);
};

export const reportResult = async (ctx: Ctx, projectRaw: string, runRaw: string): Promise<Response> => {
  const projectId = requireUuid(projectRaw, "id");
  const runId = requireUuid(runRaw, "runId");
  const { values } = await strictBody(ctx.request, {
    expectedRevision: { kind: "int", required: true },
    exitCode: { kind: "int", required: true },
    commitSha: { kind: "str", nullable: true },
    stdoutHash: { kind: "str", required: true },
    stderrHash: { kind: "str", required: true },
  });
  const expected = Number(values.expectedRevision);
  const run = await runFor(ctx, projectId, runId, expected);
  if (run.state !== "RUNNING" || run.launch_status !== "STARTED") throw transition("result requires a RUNNING run with STARTED launch status");
  const exitCode = Number(values.exitCode);
  const next: Row = {
    ...run, launch_status: "FINISHED", exit_code: exitCode, commit_sha: values.commitSha ?? null,
    stdout_hash: values.stdoutHash, stderr_hash: values.stderrHash, finished_at: ts(ctx.now),
    state: exitCode === 0 ? "VERIFYING" : "FAILED",
  };
  if (exitCode !== 0) next.failure_reason = `exit code ${exitCode}`;
  return data(200, runDto(await saveRun(ctx, next, expected)), ctx.rid);
};

const httpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
};

export const createProjectEvidence = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const projectId = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, {
    runId: { kind: "uuid", required: true },
    commitUrl: { kind: "str", required: true },
    testCommand: { kind: "str", required: true },
    testOutput: { kind: "str", required: true },
    exitCode: { kind: "int", required: true },
    metrics: { kind: "any" },
    summary: { kind: "str", required: true },
  });
  if (values.metrics !== undefined && !Array.isArray(values.metrics)) throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  const metrics = list(values.metrics).map((m) => {
    const parsed = strictObject(m, { name: { kind: "str", required: true }, value: { kind: "num", required: true }, unit: { kind: "str", required: true } }).values;
    return { name: String(parsed.name), value: Number(parsed.value), unit: String(parsed.unit) };
  });
  const commitUrl = String(values.commitUrl);
  if (!httpUrl(commitUrl)) throw fieldError("commitUrl", "must be an http(s) URL");
  await loadBlueprint(ctx, projectId);
  const runId = String(values.runId);
  const run = await loadRun(ctx, projectId, runId);
  if (!run) throw fieldError("runId", "run not found");
  if (run.state !== "VERIFYING" && run.state !== "VERIFIED") throw transition("run must be VERIFYING before evidence is submitted");
  const now = ts(ctx.now);
  const testResults = { testCommand: String(values.testCommand), testOutput: String(values.testOutput), exitCode: Number(values.exitCode) };
  const row: Row = {
    id: crypto.randomUUID(), revision: 1, project_id: projectId, run_id: runId, commit_url: commitUrl, commit_sha: run.commit_sha ?? null,
    test_results: testResults, metrics, summary: String(values.summary), status: "PENDING", verification_method: null,
    verified_at: null, career_evidence_id: null, created_at: now, updated_at: now,
  };
  await query(ctx.deps.query,
    `INSERT INTO project_evidence (${PEV_COLS}) VALUES ($1,$2,1,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,'PENDING',NULL,NULL,NULL,$10,$10)`,
    [row.id, ctx.user.id, projectId, runId, commitUrl, row.commit_sha, JSON.stringify(testResults), JSON.stringify(metrics), row.summary, now]);
  return data(201, evidenceDto(row), ctx.rid);
};

export const listProjectEvidence = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const page = pageOf(ctx.url);
  await loadBlueprint(ctx, id);
  return pageOfRows(ctx, PEV_COLS, "project_evidence", ["user_id = $1", "project_id = $2"], [ctx.user.id, id], page, evidenceDto);
};

export const dispatchProjects = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (path === "/api/v1/projects") return method === "GET" ? listProjects(ctx) : null;
  if (path === "/api/v1/projects/blueprints") return null;
  const run = path.match(/^\/api\/v1\/projects\/([^/]+)\/runs\/([^/]+)\/(start|launch|recover|result)$/);
  if (run && method === "POST") {
    if (run[3] === "start") return startRun(ctx, run[1], run[2]);
    if (run[3] === "launch") return reportLaunch(ctx, run[1], run[2]);
    if (run[3] === "recover") return recoverRun(ctx, run[1], run[2]);
    return reportResult(ctx, run[1], run[2]);
  }
  const m = path.match(/^\/api\/v1\/projects\/([^/]+)(?:\/(select|runs|evidence))?$/);
  if (!m) return null;
  const [, id, sub] = m;
  if (!sub && method === "GET") return getProject(ctx, id);
  if (sub === "select" && method === "POST") return selectProject(ctx, id);
  if (sub === "runs" && method === "GET") return listRuns(ctx, id);
  if (sub === "runs" && method === "POST") return createRun(ctx, id);
  if (sub === "evidence" && method === "GET") return listProjectEvidence(ctx, id);
  if (sub === "evidence" && method === "POST") return createProjectEvidence(ctx, id);
  return null;
};
