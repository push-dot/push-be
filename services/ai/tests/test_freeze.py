from datetime import datetime, timezone
from uuid import uuid4

from app.domain import entities as ent
from app.graphs.freeze import freeze_state, thaw_state
from app.graphs.resume_prompt import _phase_prompt


def test_freeze_keeps_excluded_user_id():
    user_id = uuid4()
    now = datetime(2026, 10, 17, tzinfo=timezone.utc)
    conv = ent.Conversation(
        id=uuid4(), user_id=user_id, title="채팅",
        created_at=now, updated_at=now)
    thawed = thaw_state(freeze_state({"conversation": conv}))
    assert thawed["conversation"].user_id == user_id
    assert thawed["conversation"].title == "채팅"


def test_log_redacts_connection_string():
    from app.api.middleware import _public_error
    text = _public_error(RuntimeError(
        "connect postgresql://push:secret@ep.neon.tech/neondb failed"))
    assert "secret" not in text
    assert "postgresql://" in text


def test_resume_markdown_is_readable():
    text = _phase_prompt(0)
    assert "현재 단계" in text
    assert len(text) > 500
