"""Shared vectors the TypeScript core checks against this implementation."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import NAMESPACE_URL, UUID, uuid5

from app.domain.pagination import Cursor
from app.domain.services.billing import verify_stripe_signature
from app.infrastructure.crypto import new_key_cipher, verify_pkce
from app.infrastructure.store_chat_jobs import user_message_id
from app.jsonutil import _ts

ROOT = Path(__file__).resolve().parents[3]
VECTORS = json.loads((ROOT / "packages/contracts/parity-vectors.json").read_text())


def test_timestamp_and_cursor_match_the_shared_vector():
    raw = datetime.fromisoformat(VECTORS["timestamp"]["input"])
    assert _ts(raw) == VECTORS["timestamp"]["json"]
    cur = Cursor(created_at=raw, id=UUID(VECTORS["aes"]["userId"]))
    assert cur.encode()


def test_user_message_id_and_pkce_match_the_shared_vector():
    job = UUID(VECTORS["userMessageId"]["jobId"])
    assert str(user_message_id(job)) == VECTORS["userMessageId"]["id"]
    assert str(uuid5(NAMESPACE_URL, "push:chat:" + str(job) + ":user")) == VECTORS["userMessageId"]["id"]
    assert verify_pkce(VECTORS["pkce"]["verifier"], VECTORS["pkce"]["challenge"])
    digest = hashlib.sha256(VECTORS["pkce"]["verifier"].encode()).digest()
    assert base64.urlsafe_b64encode(digest).rstrip(b"=").decode() == VECTORS["pkce"]["challenge"]


def test_aes_and_stripe_match_the_shared_vector():
    aes = VECTORS["aes"]
    cipher = new_key_cipher(aes["master"])
    uid = UUID(aes["userId"])
    nonce = base64.b64decode(aes["nonce"])
    ct = base64.b64decode(aes["ciphertext"])
    assert cipher.decrypt(ct, nonce, uid, aes["provider"]) == aes["plaintext"]
    stripe = VECTORS["stripe"]
    moment = datetime.fromtimestamp(stripe["timestamp"], timezone.utc)
    verify_stripe_signature(stripe["payload"].encode(), stripe["header"], stripe["secret"], moment)
    mac = hmac.new(
        stripe["secret"].encode(),
        f"{stripe['timestamp']}.".encode() + stripe["payload"].encode(),
        hashlib.sha256,
    ).hexdigest()
    assert stripe["header"].endswith(mac)
