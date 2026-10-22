"""Uploaded images. New uploads live in Postgres (`upload_images`, written by
push-be-core); files under STORAGE_DIR/images are the pre-migration copies."""

from __future__ import annotations

import os

from app.domain.errors import DomainError, validation_field


def image_dir(storage_dir: str) -> str:
    return os.path.join(storage_dir, "images")


def image_path(storage_dir: str, key: str) -> str:
    if not _safe_key(key):
        raise validation_field("key", "invalid image key")
    path = os.path.join(image_dir(storage_dir), key)
    if not os.path.isfile(path):
        raise DomainError(404, "NOT_FOUND", "resource not found")
    return path


async def image_bytes(db, key: str) -> bytes | None:
    if not _safe_key(key):
        return None
    content = await db.q().fetchval("SELECT content FROM upload_images WHERE key = $1", key)
    return None if content is None else bytes(content)


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
