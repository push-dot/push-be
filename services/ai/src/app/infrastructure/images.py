"""Local image files for recruiting uploads.

shortcut: local disk, swap to R2 at deploy
"""

from __future__ import annotations

import os
from uuid import uuid4

from app.domain.errors import DomainError, payload_too_large, validation_field

MAX_IMAGE_BYTES = 10 << 20

_ALIASES = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
    "image/heif": "image/heic",
}
_EXT = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
}


def image_dir(storage_dir: str) -> str:
    # shortcut: local disk, swap to R2 at deploy
    return os.path.join(storage_dir, "images")


def sniff_image(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) >= 12 and data[4:8] == b"ftyp" and data[8:12] in {
            b"heic", b"heix", b"heif", b"mif1", b"msf1"}:
        return "image/heic"
    return None


def normalize_type(content_type: str) -> str:
    base = (content_type or "").split(";", 1)[0].strip().lower()
    return _ALIASES.get(base, base)


def save_image(storage_dir: str, data: bytes, content_type: str) -> tuple[str, str]:
    if len(data) > MAX_IMAGE_BYTES:
        raise payload_too_large()
    declared = normalize_type(content_type)
    sniffed = sniff_image(data)
    if sniffed is None or declared not in _EXT or declared != sniffed:
        raise validation_field("file", "unsupported image type")
    key = uuid4().hex + _EXT[sniffed]
    directory = image_dir(storage_dir)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    path = os.path.join(directory, key)
    with open(path, "wb") as handle:
        handle.write(data)
    os.chmod(path, 0o600)
    return key, "/api/v1/uploads/images/" + key


def image_path(storage_dir: str, key: str) -> str:
    if not _safe_key(key):
        raise validation_field("key", "invalid image key")
    path = os.path.join(image_dir(storage_dir), key)
    if not os.path.isfile(path):
        raise DomainError(404, "NOT_FOUND", "resource not found")
    return path


def media_type(key: str) -> str:
    if key.endswith(".png"):
        return "image/png"
    if key.endswith(".webp"):
        return "image/webp"
    if key.endswith(".heic"):
        return "image/heic"
    return "image/jpeg"


def _safe_key(key: str) -> bool:
    if not key or "/" in key or "\\" in key or ".." in key:
        return False
    stem, dot, ext = key.rpartition(".")
    return bool(dot) and len(stem) == 32 and all(c in "0123456789abcdef" for c in stem) and ext in {"jpg", "png", "webp", "heic"}
