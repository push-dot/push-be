from __future__ import annotations

import math

SCORE_CAP = 20
CANDIDATE_CAP = 60
FIT_FLOOR = 7.0


def cosine_similarity(left, right) -> float:
    if not left or len(left) != len(right):
        return 0.0
    dot = 0.0
    left_norm = 0.0
    right_norm = 0.0
    for one, other in zip(left, right):
        dot += float(one) * float(other)
        left_norm += float(one) * float(one)
        right_norm += float(other) * float(other)
    denom = math.sqrt(left_norm) * math.sqrt(right_norm)
    if denom == 0:
        return 0.0
    return dot / denom


def _vectors(embedding) -> list[list[float]]:
    if not embedding:
        return []
    first = embedding[0]
    if isinstance(first, (int, float)):
        return [[float(value) for value in embedding]]
    return [[float(value) for value in vector] for vector in embedding]


def _best(user_vectors, embedding) -> float:
    best = 0.0
    found = False
    for posting in _vectors(embedding):
        for user in user_vectors:
            found = True
            best = max(best, cosine_similarity(list(user), posting))
    return best if found else 0.0


def _open(posting: dict) -> bool:
    if posting.get("status") not in (None, "OPEN"):
        return False
    return not posting.get("closed_at")


def _skill_set(value) -> set[str]:
    if isinstance(value, str):
        text = value.strip()
        return {text.casefold()} if text else set()
    if not isinstance(value, list):
        return set()
    found = set()
    for item in value:
        text = str(item).strip()
        if text:
            found.add(text.casefold())
    return found


def posting_matches(posting: dict, conditions: dict) -> bool:
    category = conditions.get("category")
    if category and posting.get("job_category") != category:
        return False
    role = str(conditions.get("role") or "").strip()
    if role:
        blob = f"{posting.get('title') or ''} {posting.get('description') or ''}"
        if role.casefold() not in blob.casefold():
            return False
    if conditions.get("careerMin") is not None:
        low = int(conditions["careerMin"])
        high = conditions.get("careerMax")
        high = 99 if high is None else int(high)
        posting_min = int(posting.get("career_min") or 0)
        posting_max = posting.get("career_max")
        posting_max = 99 if posting_max is None else int(posting_max)
        if posting_min > high or posting_max < low:
            return False
    for place in conditions.get("locations") or []:
        location = str(posting.get("location") or "")
        if place and not location.startswith(str(place)):
            return False
    needed = _skill_set(conditions.get("skills"))
    if needed and not needed <= _skill_set(posting.get("skills")):
        return False
    return True


def rank_postings(postings, user_vectors, conditions) -> list[dict]:
    vectors = [list(item) for item in user_vectors or []]
    ranked = []
    for posting in postings:
        if not _open(posting) or not posting_matches(posting, conditions):
            continue
        stored = posting.get("similarity")
        if stored is not None and posting.get("embedding") is None:
            score = float(stored)
        else:
            if vectors and not _vectors(posting.get("embedding")):
                continue
            score = _best(vectors, posting.get("embedding")) if vectors else 0.0
        ranked.append({**posting, "similarity": score})
    ranked.sort(key=lambda row: (-row["similarity"], str(row["id"])))
    return ranked


def render_matches(items: list[dict], *, header: str | None = None) -> str:
    if not items:
        return header or "조건에 맞는 공고가 없어요."
    lines = [header or "조건에 맞는 공고예요."]
    for index, item in enumerate(items, 1):
        score = item.get("fitScore")
        score_text = "적합도를 아직 못 봤어요" if score is None else f"적합도 {score:g}점"
        lines.append(
            f"{index}. {item.get('company') or ''} · {item.get('title') or ''} · "
            f"{item.get('location') or ''} · {score_text}")
    return "\n".join(lines)


def present_match(row: dict, view: dict | None) -> dict:
    return {
        "postingId": str(row["id"]),
        "company": row.get("company") or "",
        "title": row.get("title") or "",
        "location": row.get("location") or "",
        "similarity": float(row.get("similarity") or 0),
        "fitScore": None if view is None else view.get("fitScore"),
        "topGap": None if view is None else view.get("topGap"),
        "parts": None if view is None else view.get("parts"),
    }
