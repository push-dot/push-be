from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from starlette.datastructures import UploadFile

from app.api.deps import current_user, data, deps
from app.domain.errors import payload_too_large, validation_field
from app.infrastructure.images import (
    MAX_IMAGE_BYTES, image_path, media_type, save_image,
)

router = APIRouter()


@router.post("/uploads/images", status_code=201)
async def upload_image(request: Request):
    # Auth is required. The bytes land on local disk.
    # shortcut: local disk, swap to R2 at deploy
    current_user(request)
    form = await request.form()
    file = form.get("file")
    if not isinstance(file, UploadFile):
        raise validation_field("file", "required")
    if file.size is not None and file.size > MAX_IMAGE_BYTES:
        raise payload_too_large()
    buf = await file.read(MAX_IMAGE_BYTES + 1)
    key, url = save_image(deps(request).storage_dir, buf, file.content_type or "")
    return data(201, {"key": key, "url": url})


@router.get("/uploads/images/{key}")
async def get_image(key: str, request: Request):
    path = image_path(deps(request).storage_dir, key)
    return FileResponse(path, media_type=media_type(key))
