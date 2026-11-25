import logging
from collections.abc import Awaitable, Callable
from datetime import datetime
from uuid import UUID

import httpx

EXPO_PUSH = "https://exp.host/--/api/v2/push/send"

logger = logging.getLogger(__name__)


def dead_tokens(messages: list[dict], tickets: object) -> list[str]:
    """Expo answers one ticket per message, in order. DeviceNotRegistered means the app is gone
    from that device, so its token will never take a push again."""
    if not isinstance(tickets, list):
        return []
    return [
        message["to"] for message, ticket in zip(messages, tickets, strict=False)
        if isinstance(ticket, dict) and ticket.get("status") == "error"
        and (ticket.get("details") or {}).get("error") == "DeviceNotRegistered"]


def expo_push(token: str, client: httpx.AsyncClient,
              prune: Callable[[list[str]], Awaitable[object]] | None = None):
    async def push(messages: list[dict]) -> int:
        if not token:
            return 0
        try:
            res = await client.post(EXPO_PUSH, json=messages, headers={
                "authorization": "Bearer " + token, "accept": "application/json"})
            tickets = res.json().get("data") if res.status_code == 200 else None
        except (httpx.HTTPError, ValueError, AttributeError):
            return 0
        if res.status_code != 200:
            logger.warning("expo push rejected: %s", res.status_code)
            return 0
        dead = dead_tokens(messages, tickets)
        if dead and prune is not None:
            try:
                await prune(dead)
            except Exception:
                logger.exception("dead push token cleanup failed")
        failed = sum(1 for t in tickets or [] if isinstance(t, dict) and t.get("status") == "error")
        if failed:
            logger.warning("expo push: %d of %d tickets failed", failed, len(messages))
        return len(messages) - failed
    return push


def prune_devices(query):
    async def prune(tokens: list[str]) -> None:
        await query().execute("DELETE FROM user_devices WHERE token = ANY($1::text[])", tokens)
    return prune


def make_notify(query, push):
    async def notify(ctx) -> dict:
        payload = ctx.job["payload"]
        note_id = UUID(payload["notificationId"])
        user_id = UUID(payload["userId"])
        title = payload["title"]
        body = payload.get("body") or ""
        push_body = body if payload.get("pushBody") is None else payload.get("pushBody") or ""
        target = payload.get("target") or {}
        raw_conversation = payload.get("conversationId")
        conversation_id = UUID(raw_conversation) if raw_conversation else None
        try:
            inserted = await query().fetchval(
                "INSERT INTO notifications (id, user_id, type, title, body, target, read_at, created_at, conversation_id) "
                "VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8) ON CONFLICT (id) DO NOTHING RETURNING id",
                note_id, user_id, payload["kind"], title, body, target,
                datetime.fromisoformat(payload["createdAt"].replace("Z", "+00:00")),
                conversation_id)
        except Exception as err:
            if getattr(err, "sqlstate", None) != "23503":
                raise
            return {"notificationId": str(note_id), "pushed": 0}
        if inserted is None:
            return {"notificationId": str(note_id), "pushed": 0}
        # No push during the 30-day deletion grace period.
        rows = await query().fetch(
            "SELECT d.token FROM user_devices d JOIN users u ON u.id = d.user_id "
            "WHERE d.user_id = $1 AND u.deletion_requested_at IS NULL", user_id)
        messages = [{"to": row["token"], "title": title, "body": push_body, "data": target} for row in rows]
        pushed = await push(messages) if messages else 0
        return {"notificationId": str(note_id), "pushed": pushed}
    return notify
