from __future__ import annotations

from uuid import UUID

from app.config import load_config
from app.domain.plan_levers import levers_for
from app.domain.reference_text import prompt_lines, prompt_samples, template_lines
from app.infrastructure.store_jobs import ReferenceSampleStore


async def reference_lines(db, user_id, conversation_id=None) -> list[str]:
    if db is None or not user_id:
        return []
    try:
        uid = UUID(str(user_id))
    except (TypeError, ValueError):
        return []
    store = ReferenceSampleStore(db)
    row = await store.context(uid)
    if row is None:
        return []
    ctx = dict(row)
    if ctx.get("reference_data") is not True:
        return []
    category = ctx.get("job_category")
    tenure = ctx.get("tenure_years")
    if category is None or tenure is None:
        return []
    score = await _score(store, uid, conversation_id)
    levers = levers_for("PERSONAL", ctx.get("plan"), load_config())
    samples = await store.list_writing_reference(category)
    picked = prompt_samples(
        samples, category, tenure, score, levers.tenure, levers.score_band)
    return prompt_lines(picked) + template_lines(picked)


async def _score(store, user_id, conversation_id):
    if not conversation_id:
        return None
    try:
        cid = UUID(str(conversation_id))
    except (TypeError, ValueError):
        return None
    application_id = await store.conversation_application(user_id, cid)
    if not application_id:
        return None
    return await store.latest_fit(application_id)
