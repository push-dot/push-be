import { one, query } from "../db.ts";
import { HttpError, data, fieldError, pageBody, requireUuid } from "../http.ts";
import { pageOf, pageResult, ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import { notFound, readObject, textOf, countWhere, person, offerDto, OFFER_SQL, notify } from "./recruiting-shared.ts";

async function listOffers(ctx: Ctx): Promise<Response> {
  const box = ctx.url.searchParams.get("box");
  if (box !== "received" && box !== "sent") throw fieldError("box", "must be received or sent");
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  let sql = "SELECT " + OFFER_SQL + (box === "received" ? " WHERE o.profile_user_id = $1" : " WHERE o.sender_id = $1");
  const total = await countWhere(ctx, sql, " FROM offers o", params.slice());
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (o.created_at, o.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY o.created_at DESC, o.id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: offerDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid, total);
}

async function offerFor(ctx: Ctx, idRaw: string): Promise<Record<string, unknown>> {
  const id = requireUuid(idRaw, "id");
  const row = await one(ctx.deps.query, "SELECT " + OFFER_SQL + " WHERE o.id = $1 AND (o.sender_id = $2 OR o.profile_user_id = $2)", [id, ctx.user.id]);
  if (!row) throw notFound();
  return row;
}

async function getOffer(ctx: Ctx, idRaw: string): Promise<Response> {
  const row = await offerFor(ctx, idRaw);
  if (String(row.profile_user_id) === ctx.user.id && String(row.status) === "SENT") {
    const now = ctx.now.toISOString();
    await query(ctx.deps.query, "UPDATE offers SET status = 'READ', read_at = $2 WHERE id = $1 AND status = 'SENT'", [row.id, now]);
    row.status = "READ";
    row.read_at = now;
  }
  return data(200, offerDto(row), ctx.rid);
}

async function decideOffer(ctx: Ctx, idRaw: string, status: "ACCEPTED" | "DECLINED"): Promise<Response> {
  const row = await offerFor(ctx, idRaw);
  if (String(row.profile_user_id) !== ctx.user.id) throw new HttpError(403, "FORBIDDEN", "only the recipient can respond");
  const current = String(row.status);
  if (current !== "SENT" && current !== "READ") throw new HttpError(409, "CONFLICT", "offer is already closed");
  const body: Record<string, unknown> = await readObject(ctx.request).catch((err: unknown) => {
    if (err instanceof HttpError && err.message === "request body required") return {};
    throw err;
  });
  let reply = "";
  if (status === "ACCEPTED" && body.reply != null) reply = textOf(body.reply, "reply", 1, 2000);
  const now = ctx.now.toISOString();
  const decided = await one(ctx.deps.query,
    "UPDATE offers SET status = $2 WHERE id = $1 AND status IN ('SENT', 'READ') RETURNING id", [row.id, status]);
  if (!decided) throw new HttpError(409, "CONFLICT", "offer is already closed");
  if (reply) {
    await query(ctx.deps.query,
      "INSERT INTO offer_messages (id, offer_id, sender_id, body, created_at) VALUES ($1,$2,$3,$4,$5)",
      [crypto.randomUUID(), row.id, ctx.user.id, reply, now]);
  }
  row.status = status;
  if (status === "ACCEPTED") {
    await notify(ctx, String(row.sender_id), "OFFER", "제안을 수락했어요", "", { kind: "offer", id: String(row.id) });
  }
  return data(200, offerDto(row), ctx.rid);
}

async function listOfferMessages(ctx: Ctx, idRaw: string): Promise<Response> {
  const offer = await offerFor(ctx, idRaw);
  const page = pageOf(ctx.url);
  const params: unknown[] = [offer.id];
  let sql = `SELECT m.id, m.offer_id, m.sender_id, u.display_name AS sender_name, m.body, m.created_at
    FROM offer_messages m JOIN users u ON u.id = m.sender_id WHERE m.offer_id = $1`;
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (m.created_at, m.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY m.created_at DESC, m.id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({
    item: {
      id: String(row.id),
      offerId: String(row.offer_id),
      sender: person(row, "sender_id", "sender_name"),
      body: String(row.body ?? ""),
      createdAt: ts(row.created_at),
    },
    createdAt: row.created_at,
    id: String(row.id),
  }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

async function postOfferMessage(ctx: Ctx, idRaw: string): Promise<Response> {
  const offer = await offerFor(ctx, idRaw);
  if (String(offer.status) !== "ACCEPTED") throw new HttpError(409, "CONFLICT", "offer is not accepted");
  const body = await readObject(ctx.request);
  const text = textOf(body.body, "body", 1, 2000);
  const id = crypto.randomUUID();
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    "INSERT INTO offer_messages (id, offer_id, sender_id, body, created_at) VALUES ($1,$2,$3,$4,$5)",
    [id, offer.id, ctx.user.id, text, now]);
  const other = String(offer.sender_id) === ctx.user.id ? String(offer.profile_user_id) : String(offer.sender_id);
  await notify(ctx, other, "OFFER", "새 메시지", text, { kind: "offer", id: String(offer.id) });
  return data(201, {
    id, offerId: String(offer.id), sender: { id: ctx.user.id, displayName: ctx.user.displayName }, body: text, createdAt: ts(now),
  }, ctx.rid);
}

export const dispatchOffers = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (path === "/api/v1/me/offers" && method === "GET") return listOffers(ctx);
  const messages = path.match(/^\/api\/v1\/me\/offers\/([^/]+)\/messages$/);
  if (messages && method === "GET") return listOfferMessages(ctx, messages[1]);
  if (messages && method === "POST") return postOfferMessage(ctx, messages[1]);
  const accept = path.match(/^\/api\/v1\/me\/offers\/([^/]+)\/accept$/);
  if (accept && method === "POST") return decideOffer(ctx, accept[1], "ACCEPTED");
  const decline = path.match(/^\/api\/v1\/me\/offers\/([^/]+)\/decline$/);
  if (decline && method === "POST") return decideOffer(ctx, decline[1], "DECLINED");
  const offerId = path.match(/^\/api\/v1\/me\/offers\/([^/]+)$/);
  if (offerId && method === "GET") return getOffer(ctx, offerId[1]);
  return null;
};
