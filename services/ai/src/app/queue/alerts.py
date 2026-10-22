import os
from datetime import timedelta

import httpx

from app.queue.config import QUEUE_GROUPS

DEBOUNCE = timedelta(minutes=30)
WAIT_LIMIT_S = 120
DEAD_WINDOW = timedelta(minutes=10)
DB_LIMIT_BYTES = 1 << 30
DB_ALERT_RATIO = 0.8
RED = 0xE74C3C
GREEN = 0x2ECC71


async def redis_conditions(queue, now) -> dict:
    waits = {name: (await queue.stream_stats(name, group, now))["oldestAgeSec"]
             for name, group in QUEUE_GROUPS.items()}
    worst = max(waits, key=waits.get)
    dead = await queue.dead_since(now - DEAD_WINDOW)
    return {
        "queue_wait": (waits[worst] > WAIT_LIMIT_S, f"{worst} {waits[worst]}s"),
        "dead_recent": (dead > 0, f"{dead} dead in 10 min"),
    }


def db_conditions(stats, neon: dict) -> dict:
    limit = int(os.environ.get("NEON_STORAGE_LIMIT_BYTES", "") or DB_LIMIT_BYTES)
    size = neon["dbSizeBytes"]
    return {
        "heartbeat_lost": (stats.requeued > 0, f"{stats.requeued} running jobs lost their worker"),
        "db_size": (size >= limit * DB_ALERT_RATIO, f"{size} of {limit} bytes"),
    }


class Alerts:
    def __init__(self, client: httpx.AsyncClient, *, discord_url: str, resend_key: str,
                 email_from: str, email_to: str):
        self.client = client
        self.discord_url = discord_url
        self.resend_key = resend_key
        self.email_from = email_from
        self.email_to = email_to
        self.active: dict = {}

    async def evaluate(self, conditions: dict, now) -> None:
        for name, (firing, detail) in conditions.items():
            last = self.active.get(name)
            if firing and (last is None or now - last >= DEBOUNCE):
                await self.send(name, detail, now, recovered=False)
                self.active[name] = now
            elif not firing and last is not None:
                await self.send(name, detail, now, recovered=True)
                del self.active[name]

    async def send(self, name: str, detail: str, now, *, recovered: bool) -> None:
        title = ("[복구] " if recovered else "[경보] ") + name
        if self.discord_url and await self._discord(title, name, detail, now, recovered):
            return
        if self.resend_key and self.email_to:
            await self._email(title, detail, now)

    async def _discord(self, title, name, detail, now, recovered) -> bool:
        embed = {
            "title": title,
            "description": name,
            "color": GREEN if recovered else RED,
            "fields": [{"name": "값", "value": detail}],
            "timestamp": now.isoformat(),
        }
        try:
            resp = await self.client.post(self.discord_url, json={"embeds": [embed]})
        except httpx.HTTPError:
            return False
        return resp.is_success

    async def _email(self, title, detail, now) -> None:
        try:
            await self.client.post(
                "https://api.resend.com/emails",
                headers={"authorization": "Bearer " + self.resend_key},
                json={"from": self.email_from, "to": [self.email_to], "subject": title,
                      "text": f"{title}\n{detail}\n{now.isoformat()}"})
        except httpx.HTTPError:
            return


def alerts_from_env(client: httpx.AsyncClient) -> Alerts | None:
    discord = os.environ.get("DISCORD_ALERT_WEBHOOK_URL", "").strip()
    to = os.environ.get("ALERT_EMAIL_TO", "").strip()
    if not discord and not to:
        return None
    return Alerts(
        client, discord_url=discord, resend_key=os.environ.get("RESEND_API_KEY", "").strip(),
        email_from=os.environ.get("ALERT_EMAIL_FROM", "").strip() or "Push alerts <alerts@push.devcyjoon.tech>",
        email_to=to)
