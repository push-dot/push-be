import type { Route, Schema } from "./shared.ts";
import { get, post, del, ref, obj, arr, str, uuid, dateTime, enumOf, ok, noContent, pathParam } from "./shared.ts";

const id = pathParam("id", { type: "string", description: "A bot id, or the literal push for the caller's Push Bot." });

export const schemas: Record<string, Schema> = {
  CardRetry: obj({
    id: uuid,
    status: enumOf("PENDING"),
    openedAt: { ...dateTime, description: "When the card asks again: the time of this retry." },
    expiresAt: { ...dateTime, description: "openedAt plus the card's whole lifetime, so a second retry gives the same span." },
  }),
  BotSiteGrant: obj({
    host: { ...str, description: "Lowercase, without a leading www." },
    grantedAt: { ...dateTime, description: "When 항상 허용 was answered for this host." },
  }),
};

export const routes: Route[] = [
  post("core", "/api/v1/bots/{id}/approvals/{approvalId}/retry", {
    tag: "bots",
    summary: "Ask an expired card again",
    description: "다시 요청 on an expired tool card of the bot's thread. The card is PENDING again, and its openedAt and expiresAt both move to now, so its lifetime stays the same on every retry. "
      + "The run still waits on this card, so the next answer to it resumes the run (POST /bots/{id}/approvals/{approvalId}). Nothing is queued by the retry. "
      + "200 with the card's current times when it is still open. 409 APPROVAL_SUPERSEDED when the user sent a message after the card, or the card was answered and its run moved on. "
      + "409 APPROVAL_ALREADY_RESOLVED when it was closed with reject. 404 for a card that is not a tool card with a lifetime in this bot's thread.",
    params: [id, pathParam("approvalId")],
    responses: { 200: ok(ref("CardRetry")) },
  }),
  get("core", "/api/v1/bots/{id}/site-grants", {
    tag: "bots",
    summary: "List the sites a bot may read without asking",
    description: "The hosts the user answered 항상 허용 for on a page-read card of this bot, by host name. Deleting the bot deletes its grants. Clearing its chat keeps them.",
    params: [id],
    responses: { 200: ok(arr(ref("BotSiteGrant"))) },
  }),
  del("core", "/api/v1/bots/{id}/site-grants/{host}", {
    tag: "bots",
    summary: "Take back 항상 허용 for one site",
    description: "From the bot's next page read on, this host asks again. No confirm: 204 also when the bot holds no grant for the host.",
    params: [id, pathParam("host", { type: "string", minLength: 1, maxLength: 255, description: "A host of GET /bots/{id}/site-grants" })],
    responses: { 204: noContent },
  }),
];
