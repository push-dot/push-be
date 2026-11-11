from __future__ import annotations

import hashlib
import hmac as hmac_mod
from datetime import datetime, timedelta, timezone

import pytest

from app.domain.services.billing import verify_stripe_signature


def _now():
    return datetime.now(timezone.utc)


def _sign(payload: bytes, secret: str, ts: datetime) -> str:
    t = int(ts.timestamp())
    mac = hmac_mod.new(secret.encode(), f"{t}.".encode() + payload,
                       hashlib.sha256).hexdigest()
    return f"t={t},v1={mac}"


def test_verify_stripe_signature():
    payload = b'{"id":"evt_1","type":"checkout.session.completed"}'
    verify_stripe_signature(payload, _sign(payload, "whsec_test", _now()),
                            "whsec_test", _now())


def test_verify_stripe_signature_bad():
    header = _sign(b'{"other":1}', "whsec_test", _now())
    with pytest.raises(ValueError):
        verify_stripe_signature(b"{}", header, "whsec_test", _now())


def test_verify_stripe_signature_stale():
    payload = b"{}"
    header = _sign(payload, "whsec_test", _now() - timedelta(minutes=10))
    with pytest.raises(ValueError):
        verify_stripe_signature(payload, header, "whsec_test", _now())
