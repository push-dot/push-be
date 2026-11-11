from __future__ import annotations

import hashlib
import hmac as hmac_mod
from datetime import datetime

STRIPE_WEBHOOK_TOLERANCE = 300


def verify_stripe_signature(payload: bytes, header: str, secret: str,
                            now: datetime) -> None:
    ts = 0
    sigs = []
    for part in header.split(","):
        kv = part.strip().split("=", 1)
        if len(kv) != 2:
            continue
        if kv[0] == "t":
            try:
                ts = int(kv[1])
            except ValueError:
                raise ValueError("bad timestamp")
        elif kv[0] == "v1":
            sigs.append(kv[1])
    if not ts or not sigs:
        raise ValueError("missing signature")
    d = int(now.timestamp()) - ts
    if abs(d) > STRIPE_WEBHOOK_TOLERANCE:
        raise ValueError("stale timestamp")
    expected = hmac_mod.new(
        secret.encode(), f"{ts}.".encode() + payload, hashlib.sha256).hexdigest()
    if not any(hmac_mod.compare_digest(sig, expected) for sig in sigs):
        raise ValueError("signature mismatch")
