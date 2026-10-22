from datetime import datetime
from uuid import UUID

import httpx

EXPO_PUSH = "https://exp.host/--/api/v2/push/send"


def expo_push(token: str, client: httpx.AsyncClient):
    async def push(messages: list[dict]) -> int:
        if not token:
            return 0
        try:
            await client.post(EXPO_PUSH, json=messages, headers={
                "authorization": "Bearer " + token, "accept": "application/json"})
        except httpx.HTTPError:
            return 0
        return len(messages)
    return push


def make_notify(query, push):
    async def notify(ctx) -> dict:
        payload = ctx.job["payload"]
        note_id = UUID(payload["notificationId"])
        user_id = UUID(payload["userId"])
        title = payload["title"]
        body = payload.get("body") or ""
        target = payload.get("target") or {}
        inserted = await query().fetchval(
            "INSERT INTO notifications (id, user_id, type, title, body, target, read_at, created_at) "
            "VALUES ($1, $2, $3, $4, $5, $6, NULL, $7) ON CONFLICT (id) DO NOTHING RETURNING id",
            note_id, user_id, payload["kind"], title, body, target,
            datetime.fromisoformat(payload["createdAt"].replace("Z", "+00:00")))
        if inserted is None:
            return {"notificationId": str(note_id), "pushed": 0}
        rows = await query().fetch("SELECT token FROM user_devices WHERE user_id = $1", user_id)
        messages = [{"to": row["token"], "title": title, "body": body, "data": target} for row in rows]
        pushed = await push(messages) if messages else 0
        return {"notificationId": str(note_id), "pushed": pushed}
    return notify
