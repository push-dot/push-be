from __future__ import annotations

from uuid import uuid4

import pytest

from app.infrastructure.crypto import new_key_cipher


def test_key_cipher_roundtrip():
    c = new_key_cipher("test-master-key")
    uid = uuid4()
    ct, nonce = c.encrypt("secret-token", uid, "google")
    assert c.decrypt(ct, nonce, uid, "google") == "secret-token"


def test_key_cipher_wrong_purpose():
    c = new_key_cipher("test-master-key")
    uid = uuid4()
    ct, nonce = c.encrypt("secret-token", uid, "google")
    with pytest.raises(Exception):
        c.decrypt(ct, nonce, uid, "openai")
    with pytest.raises(Exception):
        c.decrypt(ct, nonce, uuid4(), "google")


def test_native_and_pure_aes_gcm_interoperate(monkeypatch):
    # Rows written by the pure-Python cipher (Workers) must still open on the VPS.
    pytest.importorskip("cryptography")  # native AES-GCM is the local extra
    from app.infrastructure import aesgcm, crypto

    c = new_key_cipher("test-master-key")
    uid = uuid4()
    nonce = b"\x01" * 12
    pure = aesgcm.encrypt(c._key, nonce, b"token", c._aad(uid, "google"))
    assert crypto.AESGCM is not None
    assert c.decrypt(pure, nonce, uid, "google") == "token"
    native, n2 = c.encrypt("token", uid, "google")
    assert aesgcm.decrypt(c._key, n2, native, c._aad(uid, "google")) == b"token"
    with pytest.raises(ValueError, match="authentication"):
        c.decrypt(native[:-1] + bytes([native[-1] ^ 1]), n2, uid, "google")


def test_verify_pkce_rejects_non_ascii_challenge_without_crashing():
    from app.infrastructure.crypto import verify_pkce

    assert verify_pkce("verifier", "챌린지") is False


async def test_google_revoke_sends_token_in_the_body_not_the_url():
    import httpx

    from app.infrastructure.google_client import GoogleClient

    seen = []
    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda r: seen.append(r) or httpx.Response(200)))
    gapi = GoogleClient.__new__(GoogleClient)
    gapi._client = client
    await gapi.revoke_token("ya29.secret")
    assert "secret" not in str(seen[0].url)
    assert seen[0].content == b"token=ya29.secret"
