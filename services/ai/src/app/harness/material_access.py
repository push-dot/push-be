from __future__ import annotations

import json
import logging
from contextvars import ContextVar
from dataclasses import dataclass
from uuid import UUID

REFUSED = (
    "내 자료 읽기가 꺼져 있어서 마이 › 서류와 북마크 공고를 읽을 수 없어요. "  # noqa: RUF001
    "서류를 직접 첨부하거나, 설정에서 내 자료 읽기를 켜 주세요."
)
READ_SWITCH_OFF = "read_switch_off"

current_access: ContextVar[MaterialAccess | None] = ContextVar("material_access", default=None)

_SQL = (
    "SELECT COALESCE((SELECT s.allow_ai_read_my_files FROM user_settings s "
    "WHERE s.user_id = $1), true) AS own_initiative, "
    "COALESCE((SELECT jsonb_agg(jsonb_build_array(a->>'kind', a->>'id')) "
    "FROM messages m "
    "CROSS JOIN LATERAL jsonb_array_elements("
    "CASE WHEN jsonb_typeof(m.attachments) = 'array' THEN m.attachments ELSE '[]'::jsonb END"
    ") a "
    "WHERE m.conversation_id = $2 AND m.user_id = $1 AND m.role = 'USER' "
    "AND NULLIF(a->>'kind', '') IS NOT NULL AND NULLIF(a->>'id', '') IS NOT NULL), "
    "'[]'::jsonb) AS attached"
)

@dataclass(frozen=True)
class MaterialAccess:
    own_initiative: bool
    attached: frozenset[tuple[str, str]]

    def allows(self, kind: str, id: str) -> bool:
        return self.own_initiative or (str(kind), str(id)) in self.attached

    def may_search(self) -> bool:
        return self.own_initiative


def refusal(*, items: bool = False, match: bool = False) -> dict:
    body = {"notice": REFUSED, "code": READ_SWITCH_OFF}
    if match:
        return {**body, "needs": "document", "items": [], "text": REFUSED}
    if items:
        return {**body, "items": []}
    return {**body, "error": "NOT_ALLOWED"}


def announce() -> None:
    from app.harness.tools import emit

    emit({"type": "notice", "text": REFUSED, "code": READ_SWITCH_OFF})


def blocked_search() -> dict | None:
    access = current_access.get()
    if access is None or access.may_search():
        return None
    announce()
    return refusal(items=True)


def blocked_id(kind: str, id) -> dict | None:
    access = current_access.get()
    if access is None or access.allows(kind, str(id)):
        return None
    announce()
    return refusal()


def message_refused(messages) -> bool:
    for message in messages or []:
        content = getattr(message, "content", "")
        if isinstance(content, str) and (READ_SWITCH_OFF in content or REFUSED in content):
            return True
    return False


def _pairs(raw) -> list[tuple[str, str]]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    found = []
    for item in raw or []:
        if isinstance(item, (list, tuple)) and len(item) >= 2 and item[0] and item[1]:
            found.append((str(item[0]), str(item[1])))
    return found


def _from_context(context) -> list[tuple[str, str]]:
    if not isinstance(context, dict):
        return []
    found = []
    document_id = context.get("documentId") or context.get("document_id")
    if document_id:
        found.append(("document", str(document_id)))
    evidence = context.get("evidenceIds") or context.get("evidence_ids") or []
    if isinstance(evidence, str):
        evidence = [evidence]
    for item in evidence:
        if item:
            found.append(("file", str(item)))
    return found


async def material_access(db, user_id, conversation_id, context=None) -> MaterialAccess:
    own = True
    attached: list[tuple[str, str]] = []
    try:
        row = await db.q().fetchrow(_SQL, UUID(str(user_id)), UUID(str(conversation_id)))
        if row is not None:
            own = bool(row["own_initiative"])
            attached = _pairs(row["attached"])
    except Exception:
        logging.getLogger(__name__).warning("material access read failed", exc_info=True)
        own = True
        attached = []
    return MaterialAccess(own, frozenset([*attached, *_from_context(context)]))
