"""graphs/chat.py completion streaming and persist: continuation rounds, hidden
file blocks, employer plan binding, resume artifacts, gates, and doc sync."""
from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.domain import entities as ent
from app.domain.employer_chat import current_employer_plan
from app.graphs.resume_prompt import gate_for_phase
from tests.test_cov2_chat_context import DB, Gate, Query, Sink, ai_dict, conv, make_svc
from tests.test_cov2_chat_context import _isolated  # noqa: F401  (autouse env fixture)


def _prepared(user_id, c, **over):
    base = {"user_id": user_id, "text": "안녕", "conversation": c, "context": {},
            "attachments": [], "ai": ai_dict(), "prepared": True,
            "prompt_user": "USER PROMPT", "prompt_system": "SYS"}
    base.update(over)
    return base


async def _generate(svc, state):
    with Sink() as events:
        out = await svc.chat_nodes["generate_reply"](state)
    return out, events


def _tokens(events):
    return [e["token"] for e in events if "token" in e]


async def test_generate_uses_the_generate_role_model_for_personal_chats():
    user_id = uuid4()
    c = conv(user_id)
    gate = Gate()
    svc = make_svc(c, gate=gate)
    out, events = await _generate(svc, _prepared(
        user_id, c, ai=ai_dict(models={"generate": "gen-model"}), job_id="job-1"))
    assert gate.calls[0] == {"model": "gen-model", "system": "SYS", "user": "USER PROMPT",
                             "prefix": "", "job_id": "job-1"}
    assert out["completion"].text == "Hello"
    assert events[0] == {"status": "응답 작성 중"}
    assert _tokens(events) == ["Hel", "lo"]


async def test_employer_turn_keeps_its_model_and_binds_the_plan_only_while_streaming():
    user_id = uuid4()
    c = conv(user_id, company_id=uuid4())
    gate = Gate()
    svc = make_svc(c, gate=gate)
    await _generate(svc, _prepared(
        user_id, c, ai=ai_dict(model="employer-model", models={"generate": "gen-model"}),
        employer_owned=True, company_plan="PRO"))
    assert gate.calls[0]["model"] == "employer-model"
    assert gate.plans == ["PRO"]
    assert current_employer_plan() is None


async def test_a_length_cut_reply_continues_from_the_partial_text():
    user_id = uuid4()
    c = conv(user_id)
    gate = Gate(rounds=[["앞부분"], ["뒷부분"]], finishes=["length", "stop"])
    svc = make_svc(c, gate=gate)
    out, events = await _generate(svc, _prepared(user_id, c))
    assert [call["prefix"] for call in gate.calls] == ["", "앞부분"]
    assert {"status": "응답이 길어 이어서 작성 중"} in events
    completion = out["completion"]
    assert (completion.text, completion.input_tokens, completion.output_tokens) == (
        "앞부분뒷부분", 4, 6)
    assert len(out["usage_ids"]) == 2


async def test_continuation_stops_after_three_rounds():
    user_id = uuid4()
    c = conv(user_id)
    gate = Gate(rounds=[["a"], ["b"], ["c"], ["d"]], finishes=["length"] * 4)
    svc = make_svc(c, gate=gate)
    out, _ = await _generate(svc, _prepared(user_id, c))
    assert len(gate.calls) == 3
    assert out["completion"].text == "abc"


async def test_resume_flow_streams_only_text_outside_file_blocks():
    user_id = uuid4()
    c = conv(user_id)
    toks = ["안녕하세요\n", "```json\n# file: 01_a.json\n", "{\"a\": 1}\n", "```\n", "끝"]
    svc = make_svc(c, gate=Gate(rounds=[toks]))
    out, events = await _generate(svc, _prepared(user_id, c, resume_flow=True, phase=1))
    assert "".join(_tokens(events)) == "안녕하세요\n\n끝"
    assert all("# file" not in t for t in _tokens(events))
    assert out["completion"].text == "".join(toks)
    assert (out["resume_flow"], out["phase"]) == (True, 1)


# ---- persist ----------------------------------------------------------------

class _Docs:
    def __init__(self):
        self.created: list = []
        self.versions: list = []

    async def create(self, user_id, application_id, title, kind, template, language):
        doc = SimpleNamespace(id=uuid4(), revision=1, title=title)
        self.created.append((user_id, application_id, title, kind, template, language))
        return doc

    async def create_version(self, user_id, doc_id, revision, content, blocks, note):
        version = SimpleNamespace(id=uuid4())
        self.versions.append((user_id, doc_id, revision, note, version.id))
        return None, version


def _completion(text):
    return ent.AICompletion(text=text, input_tokens=1, output_tokens=2)


async def _persist(svc, state):
    with Sink() as events:
        out = await svc.chat_nodes["persist"](state)
    return out, events


DRAFT = "초안을 정리했습니다.\n```md\n# file: 03_resume.md\n# 김철수\n\n- 결제 시스템 구축\n```\n"


async def test_resume_persist_saves_artifacts_adds_the_gate_and_attaches_documents():
    user_id = uuid4()
    c = conv(user_id, title="토스 지원")
    docs = _Docs()
    svc = make_svc(c, document_svc=docs)
    usage_id = uuid4()
    out, events = await _persist(svc, _prepared(
        user_id, c, completion=_completion(DRAFT), resume_flow=True, phase=2,
        usage_ids=[usage_id], text="초안 써줘"))

    gate = gate_for_phase(3)
    assert gate
    assert out["needs_approval"] is True
    assert {"token": "\n\n---\n\n" + gate} in events
    user_msg, = svc.conversations.upserted
    assistant, = svc.conversations.created
    assert assistant.text == "초안을 정리했습니다.\n\n---\n\n" + gate
    assert user_msg.text == "초안 써줘" and user_msg.operation_id == out["operation"].id
    assert docs.created == [(user_id, None, "토스 지원 이력서", "RESUME", "CLASSIC", "ko")]
    [att] = assistant.attachments
    assert (att.type, att.id, att.title) == ("DOCUMENT_VERSION", docs.versions[0][4],
                                             "토스 지원 이력서")
    op = out["operation"]
    assert op.status == ent.OP_SUCCEEDED and op.user_id == user_id
    assert op.result.value["assistantMessage"]["id"] == out["messageId"]
    assert svc.ops.created == [op]
    from app.infrastructure.resume_workspace import workspace_dir
    assert (workspace_dir(c.id, "토스 지원") / "03_resume.md").read_text().startswith("# 김철수")


async def test_resume_persist_in_blob_mode_writes_rows_and_skips_the_gate_on_a_question(
        monkeypatch):
    import app.infrastructure.resume_workspace as rw
    monkeypatch.setenv("BLOB_STORE", "db")

    async def sync_fails(*args):
        raise RuntimeError("doc service down")

    monkeypatch.setattr(rw, "sync_documents", sync_fails)
    user_id = uuid4()
    c = conv(user_id)
    q = Query(fetch=lambda sql, args: [{"name": "02_strategy.md"}]
              if "workspace_files" in sql else [])
    svc = make_svc(c, db=DB(q))
    text = "전략을 정리했어요. 진행할까요?\n```md\n# file: 02_strategy.md\n전략\n```"
    out, events = await _persist(svc, _prepared(
        user_id, c, completion=_completion(text), resume_flow=True, phase=2))
    inserts = [call for call in q.calls if call[0] == "execute"
               and "INSERT INTO workspace_files" in call[1]]
    assert [(args[0], args[1], args[2]) for _, _, args in inserts] == [
        (c.id, "02_strategy.md", "전략\n")]
    assert out["needs_approval"] is False
    assistant, = svc.conversations.created
    assert assistant.text == "전략을 정리했어요. 진행할까요?"
    assert assistant.attachments == []
    assert not [e for e in events if "token" in e]


async def test_resume_persist_save_failure_keeps_the_phase_and_a_placeholder_reply(monkeypatch):
    import app.infrastructure.resume_workspace as rw

    def boom(*args):
        raise OSError("disk full")

    monkeypatch.setattr(rw, "save_artifacts", boom)
    user_id = uuid4()
    c = conv(user_id)
    svc = make_svc(c)
    only_block = "```md\n# file: 03_resume.md\n본문\n```"
    out, _ = await _persist(svc, _prepared(
        user_id, c, completion=_completion(only_block), resume_flow=True, phase=3))
    assert out["needs_approval"] is False
    assert svc.conversations.created[0].text == "산출물을 저장했어요."


@pytest.mark.parametrize(("text", "reply"), [
    ("파일 없이 답만 했어요.", "파일 없이 답만 했어요."),
    ("", "응답 생성이 중단됐어요. 다시 시도해 주세요."),
])
async def test_resume_persist_without_artifacts_saves_the_plain_reply(text, reply):
    user_id = uuid4()
    c = conv(user_id)
    svc = make_svc(c)
    out, _ = await _persist(svc, _prepared(
        user_id, c, completion=_completion(text), resume_flow=True, phase=1))
    assert svc.conversations.created[0].text == reply
    assert out["needs_approval"] is False


async def test_pending_edit_approval_blocks_artifact_saving(monkeypatch):
    import app.infrastructure.resume_workspace as rw
    saved = []
    monkeypatch.setattr(rw, "save_artifacts", lambda *a: saved.append(a) or [])
    user_id = uuid4()
    c = conv(user_id)
    db = DB(Query())
    svc = make_svc(c, db=db)
    diff = {"documentId": str(uuid4()), "hunks": [{"sign": "+", "text": "새 줄"}]}
    out, events = await _persist(svc, _prepared(
        user_id, c, completion=_completion(DRAFT), resume_flow=True, phase=2, diff=diff))
    assert saved == []
    assert [e["type"] for e in events if "type" in e] == ["diff", "approval"]
    assert any("INSERT INTO approvals" in call[1] for call in db.query.calls)
    assert out["needs_approval"] is False


async def test_auto_applied_edit_goes_through_core_for_the_user(monkeypatch):
    import app.harness.document_edits as edits
    applied = []

    async def apply_edit(core, user_id, diff):
        applied.append((core, user_id, diff))
        return {}

    monkeypatch.setattr(edits, "apply_edit", apply_edit)
    monkeypatch.setattr(edits, "env_core", lambda: "core-client")
    user_id = uuid4()
    c = conv(user_id)
    svc = make_svc(c, document_svc=_Docs())
    diff = {"documentId": "doc-1", "hunks": [{"sign": "-", "text": "옛 줄"}]}
    _, events = await _persist(svc, _prepared(
        user_id, c, completion=_completion("고쳤어요"), diff=diff, confirm_before_edit=False))
    assert applied == [("core-client", user_id, {
        "type": "diff", "documentId": "doc-1", "revisionId": "",
        "hunks": [{"line": None, "sign": "-", "text": "옛 줄"}]})]
    assert [e["type"] for e in events if "type" in e] == ["diff"]


async def test_auto_title_failure_still_stores_the_turn():
    user_id = uuid4()
    c = conv(user_id, title="새 채팅")
    svc = make_svc(c)
    svc.conversations.update_err = RuntimeError("revision conflict")
    out, _ = await _persist(svc, _prepared(user_id, c, completion=_completion("답")))
    assert [m.role for m in svc.conversations.upserted + svc.conversations.created] == [
        "USER", "ASSISTANT"]
    assert svc.ops.created == [out["operation"]]
