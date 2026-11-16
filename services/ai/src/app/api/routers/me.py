from __future__ import annotations

import asyncio
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import Response

from app.api.deps import current_user
from app.domain.errors import not_found

router = APIRouter()

_PROFILE_SQL = (
    "SELECT u.display_name, p.headline, p.job_category, p.tenure_years, "
    "p.career_status, p.intro, p.careers, p.skills, p.avatar_key "
    "FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = $1")


@router.get("/me/profile/pdf")
async def export_my_profile(request: Request):
    from app.infrastructure.doc_render import profile_lines, render_pdf
    from app.infrastructure.images import image_bytes

    db = request.app.state.db
    row = await db.q().fetchrow(_PROFILE_SQL, current_user(request).id)
    if row is None:
        raise not_found()
    photo = None
    if request.query_params.get("photo") == "1" and row["avatar_key"]:
        photo = await image_bytes(db, row["avatar_key"])
    body = await asyncio.to_thread(
        render_pdf, profile_lines(dict(row)), None, photo)
    filename = quote(f"{row['display_name']} 프로필.pdf")
    return Response(
        content=body, media_type="application/pdf",
        headers={"Content-Disposition":
                 f"attachment; filename=profile.pdf; "
                 f"filename*=UTF-8''{filename}"})
