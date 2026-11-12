import { one, query } from "../db.ts";
import { HttpError, data, fieldError, noContent, requireUuid } from "../http.ts";
import { ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import { resolveBot } from "./bots.ts";

const notFound = (): HttpError => new HttpError(404, "NOT_FOUND", "resource not found");

// $3 is the bot. A tool card of its thread with a lifetime is the only card that can be asked again.
const RETRYABLE_CARD = `a.id = $1 AND a.user_id = $2 AND a.kind = 'TOOL_ACTION' AND a.expires_at IS NOT NULL
  AND a.conversation_id = (SELECT c.id FROM conversations c WHERE c.bot_id = $3)`;

// The card is asked again at $4, so both of its times move and the span between them stays: every retry
// gives the card its whole lifetime. Nothing resumes a run when its card expires, so the run still waits
// on this card and the next answer resumes it. approval_retryable (0058) is the rule the transcript's
// retryable reads too.
const REARM = `UPDATE approvals a SET status = 'PENDING', created_at = $4,
    expires_at = $4::timestamptz + (a.expires_at - a.created_at), updated_at = $4, revision = a.revision + 1
  WHERE ${RETRYABLE_CARD} AND a.expires_at <= $4 AND approval_retryable(a)
  RETURNING a.id, a.created_at, a.expires_at`;

const CARD = `SELECT a.id, a.status, a.created_at, a.expires_at, a.expires_at > $4 AS open,
    approval_superseded(a.conversation_id, a.created_at) AS superseded
  FROM approvals a WHERE ${RETRYABLE_CARD}`;

const cardRetry = (row: Record<string, unknown>) => ({
  id: String(row.id), status: "PENDING", openedAt: ts(row.created_at), expiresAt: ts(row.expires_at),
});

const retryCard = async (ctx: Ctx, idRaw: string, approvalRaw: string): Promise<Response> => {
  const bot = await resolveBot(ctx, idRaw);
  const params = [requireUuid(approvalRaw, "approvalId"), ctx.user.id, bot.id, ctx.now.toISOString()];
  const rearmed = await one(ctx.deps.query, REARM, params);
  if (rearmed) return data(200, cardRetry(rearmed), ctx.rid);
  const card = await one(ctx.deps.query, CARD, params);
  if (!card) throw notFound();
  if (card.superseded) throw new HttpError(409, "APPROVAL_SUPERSEDED", "a newer message moved the chat on");
  // Still open: a second tap asks nothing new.
  if (card.status === "PENDING" && card.open) return data(200, cardRetry(card), ctx.rid);
  throw new HttpError(409, "APPROVAL_ALREADY_RESOLVED", "approval already resolved");
};

// Hosts are stored lowercase without "www." (services/ai harness/approval.py site_host). Alphabetical, as the boards list them.
const listSiteGrants = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const bot = await resolveBot(ctx, idRaw);
  const rows = await query(ctx.deps.query,
    "SELECT host, kind, created_at FROM bot_site_grants WHERE bot_id = $1 ORDER BY host", [bot.id]);
  return data(200, rows.rows.map((row) => ({ host: String(row.host), kind: String(row.kind), grantedAt: ts(row.created_at) })), ctx.rid);
};

// No confirm on the board, so a second revoke of the same host answers the same.
const revokeSiteGrant = async (ctx: Ctx, idRaw: string, hostRaw: string): Promise<Response> => {
  const bot = await resolveBot(ctx, idRaw);
  let host: string;
  try { host = decodeURIComponent(hostRaw).toLowerCase(); } catch { throw fieldError("host", "must be a host name"); }
  if (host.length < 1 || host.length > 255) throw fieldError("host", "must be a host name");
  await query(ctx.deps.query, "DELETE FROM bot_site_grants WHERE bot_id = $1 AND host = $2", [bot.id, host]);
  return noContent(ctx.rid);
};

export const dispatchBotApprovals = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  const retry = path.match(/^\/api\/v1\/bots\/([^/]+)\/approvals\/([^/]+)\/retry$/);
  if (method === "POST" && retry) return retryCard(ctx, retry[1], retry[2]);
  const grants = path.match(/^\/api\/v1\/bots\/([^/]+)\/site-grants$/);
  if (method === "GET" && grants) return listSiteGrants(ctx, grants[1]);
  const grant = path.match(/^\/api\/v1\/bots\/([^/]+)\/site-grants\/([^/]+)$/);
  if (method === "DELETE" && grant) return revokeSiteGrant(ctx, grant[1], grant[2]);
  return null;
};
