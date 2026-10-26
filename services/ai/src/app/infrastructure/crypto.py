from __future__ import annotations
import base64
import hashlib
import os
import secrets
from uuid import UUID

from app.infrastructure import aesgcm

try:  # constant-time native AES on the VPS; Pyodide (Workers) keeps the pure version
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:  # pragma: no cover - Workers only
    AESGCM = None


def new_key_cipher(master: str) -> "KeyCipher":
    try:
        raw = base64.b64decode(master, validate=True) if master else b""
    except Exception:
        raw = b""
    if len(raw) != 32:
        if not master:
            raise ValueError("empty master key")
        raw = hashlib.sha256(master.encode()).digest()
    return KeyCipher(raw)


class KeyCipher:
    def __init__(self, key: bytes):
        self._key = key

    @staticmethod
    def _aad(user_id: UUID, provider: str) -> bytes:
        return f"{user_id}|{provider}|v1".encode()

    def encrypt(self, plaintext: str, user_id: UUID, provider: str) -> tuple[bytes, bytes]:
        nonce = os.urandom(12)
        aad = self._aad(user_id, provider)
        if AESGCM is not None:
            return AESGCM(self._key).encrypt(nonce, plaintext.encode(), aad), nonce
        return aesgcm.encrypt(self._key, nonce, plaintext.encode(), aad), nonce

    def decrypt(self, ciphertext: bytes, nonce: bytes, user_id: UUID, provider: str) -> str:
        aad = self._aad(user_id, provider)
        if AESGCM is None:
            return aesgcm.decrypt(self._key, nonce, ciphertext, aad).decode()
        if len(nonce) != 12:
            raise ValueError("nonce must be 12 bytes")
        try:
            return AESGCM(self._key).decrypt(nonce, ciphertext, aad).decode()
        except InvalidTag:
            raise ValueError("GCM authentication failed") from None


def random_token() -> str:
    return secrets.token_urlsafe(32)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def token_hash(token: str) -> str:
    return sha256_hex(token.encode())


def verify_pkce(verifier: str, challenge: str) -> bool:
    if not verifier:
        return False
    digest = hashlib.sha256(verifier.encode()).digest()
    # bytes, not str: compare_digest raises TypeError on non-ASCII str input.
    return secrets.compare_digest(
        base64.urlsafe_b64encode(digest).rstrip(b"="), challenge.encode())
