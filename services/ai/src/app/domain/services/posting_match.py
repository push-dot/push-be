from __future__ import annotations

from uuid import UUID

from app.domain.posting_match import SCORE_CAP, FIT_FLOOR, present_match, rank_postings, render_matches


def _uuid(value):
    if value in (None, ""):
        return None
    try:
        return UUID(str(value))
    except ValueError:
        return None


async def find_matching_postings(postings, user_vectors, conditions, *, score_fit, cap=SCORE_CAP):
    ranked = rank_postings(postings, user_vectors, conditions or {})
    chosen = ranked[:cap]
    items = []
    for row in chosen:
        view = await score_fit(row, (conditions or {}).get("documentId"))
        items.append(present_match(row, view))
    if (conditions or {}).get("minFit"):
        items = [
            item for item in items
            if item.get("fitScore") is not None and float(item["fitScore"]) >= FIT_FLOOR
        ]
    items.sort(key=lambda item: (
        -(item["fitScore"] if item.get("fitScore") is not None else -1),
        -item["similarity"],
        item["postingId"],
    ))
    return {"items": items, "scored": len(chosen), "text": render_matches(items)}


async def run_quick_match(db, user_id, inputs, job_id=None):
    from app.harness.personal.tools import current_ai_gate
    from app.infrastructure.posting_fit_cache import load_fit
    from app.infrastructure.posting_match import load_corpus, latest_document_id

    conditions = dict(inputs or {})
    user = _uuid(user_id)
    document_id = _uuid(conditions.get("documentId"))
    query = None if db is None else db.q()
    if query is not None and document_id is None and user is not None:
        document_id = await latest_document_id(query, user)
        if document_id is not None:
            conditions["documentId"] = str(document_id)
    postings, user_vectors = await load_corpus(query, user, document_id)
    gate = current_ai_gate()

    async def score_fit(row, doc):
        parsed = _uuid(doc)
        if query is None or user is None or parsed is None:
            return None
        return await load_fit(
            query, user, row["id"], parsed, gate=gate, job_id=job_id)

    return await find_matching_postings(
        postings, user_vectors, conditions, score_fit=score_fit)
