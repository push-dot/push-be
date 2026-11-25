from uuid import uuid4

import pytest

from app.domain.a2ui import surfaces
from app.harness.approval import approval_conversation_id, tool_action_event
from app.harness.personal.tools import ProfilePatch, _profile_rows


class Now:
    def __init__(self, row):
        self.row = row

    def q(self):
        return self

    async def fetchrow(self, sql, conversation_id):
        assert "FROM conversations c JOIN users u" in sql
        return self.row


@pytest.mark.asyncio
async def test_a_profile_edit_card_shows_each_changed_field_now_and_after():
    token = approval_conversation_id.set(str(uuid4()))
    try:
        rows = await _profile_rows(
            ProfilePatch(headline="백엔드 개발자"), Now({"display_name": "Ada", "headline": "풀스택 개발자"}))
        blank = await _profile_rows({"display_name": "에이다"}, Now({"display_name": "", "headline": ""}))
    finally:
        approval_conversation_id.reset(token)
    assert rows == [{"name": "헤드라인", "from": "풀스택 개발자", "to": "백엔드 개발자"}]
    assert blank == [{"name": "이름", "from": "비어 있음", "to": "에이다"}]
    event = tool_action_event("a1", "내 프로필을 수정해요", "update_my_profile", {"headline": "백엔드 개발자"}, rows)
    drawn = str(surfaces("approval", event))
    assert "헤드라인 · 풀스택 개발자 → 백엔드 개발자" in drawn


@pytest.mark.asyncio
async def test_no_rows_outside_a_conversation():
    assert await _profile_rows(ProfilePatch(headline="x"), Now(None)) == []
