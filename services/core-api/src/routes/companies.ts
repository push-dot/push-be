import { isUndefinedColumn, isUnique, one, query } from "../db.ts";
import { HttpError, codePoints, data, noContent, randomToken, sha256Hex } from "../http.ts";
import { createMailer, type Mailer } from "../mail/mailer.ts";
import { ts } from "../page.ts";
import type { Ctx } from "../types.ts";

const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
const NOT_VERIFIED = "사업자 정보를 확인하지 못했어요. 개업 직후라면 1–2일 뒤 다시 시도해 주세요";
const MINE = "SELECT c.id, c.b_no, c.name, c.plan, c.verified_at, m.role, (SELECT count(*) FROM company_members mm WHERE mm.company_id = c.id AND mm.role = 'MEMBER') AS member_count, (SELECT count(*) FROM company_invites i WHERE i.company_id = c.id AND i.accepted_at IS NULL AND i.expires_at > $2) AS invite_count FROM company_members m JOIN companies c ON c.id = m.company_id WHERE m.user_id = $1";
const MINE_PROFILE = "SELECT c.id, c.b_no, c.name, c.plan, c.verified_at, c.logo_key, c.industry, c.website, c.intro, c.representative_name, m.role, (SELECT count(*) FROM company_members mm WHERE mm.company_id = c.id AND mm.role = 'MEMBER') AS member_count, (SELECT count(*) FROM company_invites i WHERE i.company_id = c.id AND i.accepted_at IS NULL AND i.expires_at > $2) AS invite_count FROM company_members m JOIN companies c ON c.id = m.company_id WHERE m.user_id = $1";
const IMAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const PROFILE_KEYS = new Set(["logoKey", "industry", "website", "intro", "representativeName"]);
const INVITE_SEAT = `WHERE (
       (SELECT count(*) FROM company_members WHERE company_id = $2 AND role = 'MEMBER')
       + (SELECT count(*) FROM company_invites WHERE company_id = $2 AND accepted_at IS NULL AND expires_at > $6)
     ) < $7`;

const mailerOf = (ctx: Ctx): Mailer => ctx.deps.mailer ?? createMailer(ctx.env, ctx.deps.fetch);

const originOf = (ctx: Ctx): string => (ctx.env.APP_WEB_ORIGIN || "http://localhost:5174").replace(/\/+$/, "");

const seatLimit = (plan: unknown): number => {
  if (plan === "PRO") return 2;
  if (plan === "ULTRA") return 5;
  return 0;
};

const planOf = (value: unknown): "BASIC" | "PRO" | "ULTRA" | null => {
  if (value === "BASIC" || value === "PRO" || value === "ULTRA") return value;
  return null;
};

const usedOf = (row: Record<string, unknown>): number => Number(row.member_count ?? 0) + Number(row.invite_count ?? 0);

const imageUrl = (key: unknown): string | null => {
  if (key == null || key === "") return null;
  return "/api/v1/uploads/images/" + encodeURIComponent(String(key));
};

const textOrNull = (value: unknown): string | null => value == null ? null : String(value);

const companyJson = (row: Record<string, unknown>) => {
  const plan = planOf(row.plan);
  const body: Record<string, unknown> = {
    id: String(row.id),
    bNo: row.b_no == null ? "" : String(row.b_no),
    name: String(row.name ?? ""),
    plan,
    verifiedAt: row.verified_at == null ? null : ts(row.verified_at),
    role: String(row.role),
    seats: { used: usedOf(row), limit: seatLimit(plan) },
  };
  if (!("logo_key" in row)) return body;
  body.logoKey = textOrNull(row.logo_key);
  body.logoUrl = imageUrl(row.logo_key);
  body.industry = textOrNull(row.industry);
  body.website = textOrNull(row.website);
  body.intro = textOrNull(row.intro);
  body.representativeName = textOrNull(row.representative_name);
  return body;
};

const invalid = (field: string): HttpError => new HttpError(400, "VALIDATION_ERROR", "invalid request body", { field });

const optionalText = (value: unknown, field: string, max: number): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || codePoints(value) < 1 || codePoints(value) > max) throw invalid(field);
  return value;
};

const httpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
};

const logoKeyOf = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || !IMAGE_KEY.test(value) || value.includes("..")) throw invalid("logoKey");
  return value;
};

const websiteOf = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || codePoints(value) < 1 || codePoints(value) > 2000 || !httpUrl(value)) throw invalid("website");
  return value;
};

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  const raw = await request.text();
  if (!raw) throw new HttpError(400, "VALIDATION_ERROR", "request body required");
  try {
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
    }
    return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
};

const requireEmployer = (ctx: Ctx): void => {
  if (ctx.user.accountType !== "EMPLOYER") throw new HttpError(403, "FORBIDDEN", "employer account required");
};

const fieldText = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body", { field: key });
  }
  return value.trim();
};

const requireEmail = (value: unknown): string => {
  if (typeof value !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw new HttpError(400, "VALIDATION_ERROR", "must be an email", { field: "email" });
  }
  return value.trim().toLowerCase();
};

const businessError = (reason: "MISMATCH" | "SUSPENDED" | "CLOSED"): HttpError =>
  new HttpError(422, "BUSINESS_NOT_VERIFIED", NOT_VERIFIED, { reason });

const notFound = (): HttpError => new HttpError(404, "NOT_FOUND", "resource not found");

const rowOf = (body: unknown): Record<string, unknown> | null => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const list = (body as { data?: unknown }).data;
  if (!Array.isArray(list) || list.length === 0) return null;
  const row = list[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  return row as Record<string, unknown>;
};

const postNts = async (ctx: Ctx, url: string, payload: unknown): Promise<unknown> => {
  const fetchImpl = ctx.deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new HttpError(502, "PROVIDER_ERROR", "nts request failed");
  }
  if (!res.ok) throw new HttpError(502, "PROVIDER_ERROR", "nts request failed");
  try {
    return await res.json();
  } catch {
    throw new HttpError(502, "PROVIDER_ERROR", "nts request failed");
  }
};

const loadMine = async (ctx: Ctx): Promise<Record<string, unknown>> => {
  const params = [ctx.user.id, ctx.now.toISOString()];
  try {
    const row = await one(ctx.deps.query, MINE_PROFILE, params);
    if (!row) throw notFound();
    return row;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (!isUndefinedColumn(err)) throw err;
  }
  const row = await one(ctx.deps.query, MINE, params);
  if (!row) throw notFound();
  return row;
};

const requireAdmin = async (ctx: Ctx): Promise<Record<string, unknown>> => {
  const row = await loadMine(ctx);
  if (String(row.role) !== "ADMIN") throw new HttpError(403, "FORBIDDEN", "admin required");
  return row;
};

const verifyBusiness = async (ctx: Ctx): Promise<Response> => {
  requireEmployer(ctx);
  const body = await readJson(ctx.request);
  const bNo = fieldText(body, "bNo");
  const startDt = fieldText(body, "startDt");
  const pNm = fieldText(body, "pNm");
  const bNm = fieldText(body, "bNm");
  if (!/^\d{10}$/.test(bNo)) throw new HttpError(400, "VALIDATION_ERROR", "invalid request body", { field: "bNo" });
  if (!/^\d{8}$/.test(startDt)) throw new HttpError(400, "VALIDATION_ERROR", "invalid request body", { field: "startDt" });
  const existing = await one(ctx.deps.query,
    "SELECT m.company_id, m.role, c.verified_at FROM company_members m JOIN companies c ON c.id = m.company_id WHERE m.user_id = $1",
    [ctx.user.id]);
  const shell = existing != null && existing.verified_at == null && String(existing.role) === "ADMIN";
  if (existing && !shell) throw new HttpError(409, "CONFLICT", "already in a company");
  const key = ctx.env.NTS_SERVICE_KEY;
  if (!key) throw new HttpError(503, "NOT_CONFIGURED", "nts is not configured");
  const validated = rowOf(await postNts(
    ctx,
    `https://api.odcloud.kr/api/nts-businessman/v1/validate?serviceKey=${encodeURIComponent(key)}`,
    { businesses: [{ b_no: bNo, start_dt: startDt, p_nm: pNm, b_nm: bNm }] },
  ));
  if (!validated || validated.valid !== "01") throw businessError("MISMATCH");
  const status = rowOf(await postNts(
    ctx,
    `https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=${encodeURIComponent(key)}`,
    { b_no: [bNo] },
  ));
  const code = status?.b_stt_cd;
  if (code === "02") throw businessError("SUSPENDED");
  if (code === "03") throw businessError("CLOSED");
  if (code !== "01") throw businessError("MISMATCH");
  const now = ctx.now.toISOString();
  if (shell && existing) {
    const companyId = String(existing.company_id);
    try {
      const updated = await query(ctx.deps.query,
        "UPDATE companies SET b_no = $2, name = $3, verified_at = $4 WHERE id = $1 AND verified_at IS NULL",
        [companyId, bNo, bNm, now]);
      if ((updated.rowCount ?? 0) === 0) throw new HttpError(409, "CONFLICT", "already in a company");
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (isUnique(err)) throw new HttpError(409, "COMPANY_EXISTS", "company already exists");
      throw err;
    }
    return data(201, {
      id: companyId,
      bNo,
      name: bNm,
      plan: null,
      verifiedAt: ts(ctx.now),
      role: "ADMIN",
      seats: { used: 0, limit: 0 },
    }, ctx.rid);
  }
  const companyId = crypto.randomUUID();
  try {
    await query(ctx.deps.query,
      "INSERT INTO companies (id, b_no, name, verified_at, plan, created_at) VALUES ($1,$2,$3,$4,NULL,$5)",
      [companyId, bNo, bNm, now, now]);
  } catch (err) {
    if (isUnique(err)) throw new HttpError(409, "COMPANY_EXISTS", "company already exists");
    throw err;
  }
  try {
    await query(ctx.deps.query,
      "INSERT INTO company_members (company_id, user_id, role, created_at) VALUES ($1,$2,$3,$4)",
      [companyId, ctx.user.id, "ADMIN", now]);
  } catch (err) {
    await query(ctx.deps.query, "DELETE FROM companies WHERE id = $1", [companyId]);
    if (isUnique(err)) throw new HttpError(409, "CONFLICT", "already in a company");
    throw err;
  }
  return data(201, {
    id: companyId,
    bNo,
    name: bNm,
    plan: null,
    verifiedAt: ts(ctx.now),
    role: "ADMIN",
    seats: { used: 0, limit: 0 },
  }, ctx.rid);
};

const myCompany = async (ctx: Ctx): Promise<Response> => data(200, companyJson(await loadMine(ctx)), ctx.rid);

const listMembers = async (ctx: Ctx): Promise<Response> => {
  const mine = await loadMine(ctx);
  const rows = await query(ctx.deps.query,
    "SELECT m.user_id, u.email, m.role, m.created_at FROM company_members m JOIN users u ON u.id = m.user_id WHERE m.company_id = $1 ORDER BY m.created_at ASC, m.user_id ASC",
    [String(mine.id)]);
  return data(200, rows.rows.map((row) => ({
    userId: String(row.user_id),
    email: row.email == null ? "" : String(row.email),
    role: String(row.role),
    joinedAt: ts(row.created_at),
  })), ctx.rid);
};

const sendInvite = async (ctx: Ctx, email: string, raw: string): Promise<void> => {
  const url = `${originOf(ctx)}/invites/${raw}`;
  await mailerOf(ctx).send({
    to: email,
    subject: "회사 초대",
    text: url,
    html: `<p><a href="${url}">${url}</a></p>`,
    idempotencyKey: raw,
  });
};

const insertInvite = async (
  ctx: Ctx,
  inviteId: string,
  companyId: string,
  email: string,
  hash: string,
  expires: string,
  nowIso: string,
  limit: number,
) => {
  const params = [inviteId, companyId, email, hash, expires, nowIso, limit, ctx.user.id];
  try {
    return await query(ctx.deps.query,
      `INSERT INTO company_invites (id, company_id, email, token_hash, expires_at, accepted_at, inviter_user_id)
       SELECT $1, $2, $3, $4, $5, NULL, $8
       ${INVITE_SEAT}`,
      params);
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    return await query(ctx.deps.query,
      `INSERT INTO company_invites (id, company_id, email, token_hash, expires_at, accepted_at)
       SELECT $1, $2, $3, $4, $5, NULL
       ${INVITE_SEAT}`,
      params.slice(0, 7));
  }
};

const updateInviteToken = async (ctx: Ctx, id: string, hash: string, expires: string): Promise<void> => {
  try {
    await query(ctx.deps.query,
      "UPDATE company_invites SET token_hash = $2, expires_at = $3, inviter_user_id = $4 WHERE id = $1",
      [id, hash, expires, ctx.user.id]);
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    await query(ctx.deps.query,
      "UPDATE company_invites SET token_hash = $2, expires_at = $3 WHERE id = $1",
      [id, hash, expires]);
  }
};

const invite = async (ctx: Ctx): Promise<Response> => {
  const mine = await requireAdmin(ctx);
  const body = await readJson(ctx.request);
  const email = requireEmail(body.email);
  const companyId = String(mine.id);
  const member = await one(ctx.deps.query,
    "SELECT m.user_id FROM company_members m JOIN users u ON u.id = m.user_id WHERE m.company_id = $1 AND lower(u.email) = lower($2)",
    [companyId, email]);
  if (member) throw new HttpError(409, "CONFLICT", "already a member");
  const nowIso = ctx.now.toISOString();
  const pending = await one(ctx.deps.query,
    "SELECT id FROM company_invites WHERE company_id = $1 AND lower(email) = lower($2) AND accepted_at IS NULL AND expires_at > $3",
    [companyId, email, nowIso]);
  const raw = randomToken();
  const hash = await sha256Hex(raw);
  const expires = new Date(ctx.now.getTime() + INVITE_MS).toISOString();
  if (pending) {
    try {
      await sendInvite(ctx, email, raw);
    } catch {
      throw new HttpError(502, "PROVIDER_ERROR", "invite mail failed");
    }
    await updateInviteToken(ctx, String(pending.id), hash, expires);
    return data(201, { email }, ctx.rid);
  }
  const plan = planOf(mine.plan);
  if (usedOf(mine) >= seatLimit(plan)) throw new HttpError(403, "SEAT_LIMIT", "seat limit reached");
  const inviteId = crypto.randomUUID();
  const inserted = await insertInvite(ctx, inviteId, companyId, email, hash, expires, nowIso, seatLimit(plan));
  if ((inserted.rowCount ?? 0) === 0) throw new HttpError(403, "SEAT_LIMIT", "seat limit reached");
  try {
    await sendInvite(ctx, email, raw);
  } catch {
    await query(ctx.deps.query, "DELETE FROM company_invites WHERE id = $1", [inviteId]);
    throw new HttpError(502, "PROVIDER_ERROR", "invite mail failed");
  }
  return data(201, { email }, ctx.rid);
};

const patchCompany = async (ctx: Ctx): Promise<Response> => {
  const mine = await requireAdmin(ctx);
  const body = await readJson(ctx.request);
  for (const key of Object.keys(body)) {
    if (!PROFILE_KEYS.has(key)) throw invalid(key);
  }
  const params: unknown[] = [String(mine.id)];
  const sets: string[] = [];
  const add = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if ("logoKey" in body) add("logo_key", logoKeyOf(body.logoKey));
  if ("industry" in body) add("industry", optionalText(body.industry, "industry", 80));
  if ("website" in body) add("website", websiteOf(body.website));
  if ("intro" in body) add("intro", optionalText(body.intro, "intro", 2000));
  if ("representativeName" in body) add("representative_name", optionalText(body.representativeName, "representativeName", 80));
  if (sets.length > 0) {
    await query(ctx.deps.query, `UPDATE companies SET ${sets.join(", ")} WHERE id = $1`, params);
  }
  return data(200, companyJson(await loadMine(ctx)), ctx.rid);
};

const listInvites = async (ctx: Ctx): Promise<Response> => {
  const mine = await requireAdmin(ctx);
  const rows = await query(ctx.deps.query,
    "SELECT id, email, expires_at FROM company_invites WHERE company_id = $1 AND accepted_at IS NULL AND expires_at > $2 ORDER BY expires_at ASC, id ASC",
    [String(mine.id), ctx.now.toISOString()]);
  return data(200, rows.rows.map((row) => ({
    id: String(row.id),
    email: row.email == null ? "" : String(row.email),
    expiresAt: ts(row.expires_at),
  })), ctx.rid);
};

const loadInvitePreview = async (ctx: Ctx, hash: string): Promise<Record<string, unknown> | null> => {
  try {
    return await one(ctx.deps.query,
      "SELECT i.id, i.company_id, i.email, i.expires_at, i.accepted_at, i.inviter_user_id, c.name AS company_name, c.deletion_requested_at FROM company_invites i JOIN companies c ON c.id = i.company_id WHERE i.token_hash = $1",
      [hash]);
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    return await one(ctx.deps.query,
      "SELECT i.id, i.company_id, i.email, i.expires_at, i.accepted_at, c.name AS company_name, c.deletion_requested_at FROM company_invites i JOIN companies c ON c.id = i.company_id WHERE i.token_hash = $1",
      [hash]);
  }
};

const namedMember = (row: Record<string, unknown>) => ({
  name: row.display_name == null ? "" : String(row.display_name),
  role: String(row.role),
});

const earliestAdmin = async (ctx: Ctx, companyId: string) => {
  const row = await one(ctx.deps.query,
    "SELECT u.display_name, m.role FROM company_members m JOIN users u ON u.id = m.user_id WHERE m.company_id = $1 AND m.role = 'ADMIN' ORDER BY m.created_at ASC, m.user_id ASC LIMIT 1",
    [companyId]);
  if (!row) return null;
  return namedMember(row);
};

const inviterOf = async (ctx: Ctx, row: Record<string, unknown>) => {
  const companyId = String(row.company_id);
  if (row.inviter_user_id != null) {
    const user = await one(ctx.deps.query,
      "SELECT u.display_name, m.role FROM company_members m JOIN users u ON u.id = m.user_id WHERE m.company_id = $1 AND m.user_id = $2",
      [companyId, String(row.inviter_user_id)]);
    if (user) return namedMember(user);
  }
  return earliestAdmin(ctx, companyId);
};

const previewInvite = async (ctx: Ctx, token: string): Promise<Response> => {
  const row = await loadInvitePreview(ctx, await sha256Hex(token));
  if (!row || row.accepted_at != null || row.deletion_requested_at != null) throw notFound();
  const expires = Date.parse(String(row.expires_at));
  if (Number.isNaN(expires) || ctx.now.getTime() > expires) throw notFound();
  const inviter = await inviterOf(ctx, row);
  if (!inviter) throw notFound();
  return data(200, {
    companyName: row.company_name == null ? "" : String(row.company_name),
    inviterName: inviter.name,
    inviterRole: inviter.role,
    email: row.email == null ? "" : String(row.email),
    expiresAt: ts(row.expires_at),
  }, ctx.rid);
};

const acceptInvite = async (ctx: Ctx, token: string): Promise<Response> => {
  requireEmployer(ctx);
  const inviteRow = await one(ctx.deps.query,
    "SELECT i.id, i.company_id, i.email, i.expires_at, i.accepted_at, c.deletion_requested_at FROM company_invites i JOIN companies c ON c.id = i.company_id WHERE i.token_hash = $1",
    [await sha256Hex(token)]);
  if (!inviteRow) throw notFound();
  if (inviteRow.accepted_at != null) throw new HttpError(409, "CONFLICT", "invite already accepted");
  if (inviteRow.deletion_requested_at != null) throw new HttpError(409, "CONFLICT", "company is pending deletion");
  const expires = Date.parse(String(inviteRow.expires_at));
  if (Number.isNaN(expires) || ctx.now.getTime() > expires) throw notFound();
  const user = await one(ctx.deps.query, "SELECT email FROM users WHERE id = $1", [ctx.user.id]);
  const actual = user?.email == null ? "" : String(user.email).trim().toLowerCase();
  const expected = String(inviteRow.email ?? "").trim().toLowerCase();
  if (!actual || actual !== expected) throw new HttpError(403, "FORBIDDEN", "invite email does not match");
  const membership = await one(ctx.deps.query, "SELECT company_id FROM company_members WHERE user_id = $1", [ctx.user.id]);
  if (membership) throw new HttpError(409, "CONFLICT", "already in a company");
  const now = ctx.now.toISOString();
  try {
    await query(ctx.deps.query,
      "INSERT INTO company_members (company_id, user_id, role, created_at) VALUES ($1,$2,$3,$4)",
      [String(inviteRow.company_id), ctx.user.id, "MEMBER", now]);
  } catch (err) {
    if (isUnique(err)) throw new HttpError(409, "CONFLICT", "already in a company");
    throw err;
  }
  await query(ctx.deps.query, "UPDATE company_invites SET accepted_at = $2 WHERE id = $1", [String(inviteRow.id), now]);
  return noContent(ctx.rid);
};

const removeMember = async (ctx: Ctx, userId: string): Promise<Response> => {
  const mine = await requireAdmin(ctx);
  const companyId = String(mine.id);
  const target = await one(ctx.deps.query,
    "SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2",
    [companyId, userId]);
  if (!target) throw notFound();
  if (String(target.role) === "ADMIN") {
    const admins = await one(ctx.deps.query,
      "SELECT count(*) AS admins FROM company_members WHERE company_id = $1 AND role = 'ADMIN'",
      [companyId]);
    if (Number(admins?.admins ?? 0) <= 1) throw new HttpError(409, "CONFLICT", "cannot remove the last admin");
  }
  await query(ctx.deps.query, "DELETE FROM company_members WHERE company_id = $1 AND user_id = $2", [companyId, userId]);
  return noContent(ctx.rid);
};

const transferAdmin = async (ctx: Ctx, userId: string): Promise<Response> => {
  const body = await readJson(ctx.request);
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "role" || body.role !== "ADMIN") {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body", { field: "role" });
  }
  const mine = await requireAdmin(ctx);
  const companyId = String(mine.id);
  const target = await one(ctx.deps.query,
    "SELECT user_id, role FROM company_members WHERE company_id = $1 AND user_id = $2",
    [companyId, userId]);
  if (!target) throw notFound();
  if (String(target.role) !== "ADMIN") {
    await query(ctx.deps.query, "UPDATE company_members SET role = 'ADMIN' WHERE company_id = $1 AND user_id = $2", [companyId, userId]);
    await query(ctx.deps.query, "UPDATE company_members SET role = 'MEMBER' WHERE company_id = $1 AND role = 'ADMIN' AND user_id <> $2", [companyId, userId]);
  }
  return noContent(ctx.rid);
};

export const dispatchCompanies = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (method === "POST" && path === "/api/v1/companies/verify") return verifyBusiness(ctx);
  if (method === "GET" && path === "/api/v1/companies/me") return myCompany(ctx);
  if (method === "PATCH" && path === "/api/v1/companies/me") return patchCompany(ctx);
  if (method === "GET" && path === "/api/v1/companies/me/members") return listMembers(ctx);
  if (method === "GET" && path === "/api/v1/companies/me/invites") return listInvites(ctx);
  if (method === "POST" && path === "/api/v1/companies/me/invites") return invite(ctx);
  const preview = path.match(/^\/api\/v1\/companies\/invites\/([^/]+)$/);
  if (method === "GET" && preview) return previewInvite(ctx, decodeURIComponent(preview[1]));
  const accept = path.match(/^\/api\/v1\/companies\/invites\/([^/]+)\/accept$/);
  if (method === "POST" && accept) return acceptInvite(ctx, decodeURIComponent(accept[1]));
  const member = path.match(/^\/api\/v1\/companies\/me\/members\/([^/]+)$/);
  if (!member) return null;
  const userId = member[1];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new HttpError(400, "VALIDATION_ERROR", "must be a UUID", { field: "userId" });
  }
  if (method === "DELETE") return removeMember(ctx, userId.toLowerCase());
  if (method === "PATCH") return transferAdmin(ctx, userId.toLowerCase());
  return null;
};
