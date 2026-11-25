from __future__ import annotations

from app.harness.kstyle.budget import BUDGETS, budget_for
from app.harness.kstyle.ledger import add_evidence, assume, empty_notes, ledger_text, verified
from app.harness.kstyle.workspace import load_json, load_notes, save_json, save_notes
from app.harness.tools import ToolContext


class _Files:
    def __init__(self):
        self.files = {}

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        body = self.files.get((args[0], args[1]))
        return None if body is None else {"body": body}

    async def execute(self, sql, *args):
        self.files[(args[0], args[1])] = args[2]
        return "INSERT 1"


def _ctx(db):
    return ToolContext(user_id="u", company_id=None, conversation_id="c", job_id="j", tool_call_id="t",
                       db=db, core=None)


def test_code_decides_verified_and_ids_count_up():
    notes = empty_notes()
    first = add_evidence(notes, "repo", "acme/widgets:README.md", "  Widgets  ship weekly ", "주 1회 배포",
                         text="Widgets ship\nweekly to users")
    second = add_evidence(notes, "company", "https://a.example", "made up", "지어낸 말", text="nothing")
    assert (first["id"], first["verified"]) == ("E1", True)
    assert (second["id"], second["verified"]) == ("E2", False)
    assert list(verified(notes)) == ["E1"]
    assert ledger_text(notes).splitlines()[0].startswith("E1 [repo·확인]")


def test_a_quote_shorter_than_four_characters_proves_nothing():
    notes = empty_notes()
    short = add_evidence(notes, "doc", "s", "다", "지어낸 주장", text="했습니다")
    assert short["verified"] is False
    assert add_evidence(notes, "doc", "s", "했습니다", "주장", text="했습니다")["verified"] is True


def test_an_oversized_line_does_not_drop_the_lines_after_it():
    notes = empty_notes()
    add_evidence(notes, "doc", "s", "first quote", "가" * 7000, text="first quote")
    add_evidence(notes, "doc", "s", "second quote", "짧은 주장", text="second quote")
    text = ledger_text(notes, limit=300)
    assert "E2 [doc·확인] s: 짧은 주장" in text and "E1" not in text


def test_assume_logs_each_assumption_once():
    notes = empty_notes()
    assume(notes, "회사 A의 신입 공고로 봤어요")
    assume(notes, "회사 A의 신입 공고로 봤어요")
    assume(notes, "  ")
    assert notes["assumptions"] == ["회사 A의 신입 공고로 봤어요"]


async def test_notes_round_trip_under_their_own_name():
    db = _Files()
    notes = empty_notes()
    assume(notes, "가정")
    await save_notes(_ctx(db), notes, "00_notes.chat.json")
    assert (await load_notes(_ctx(db), "00_notes.chat.json"))["assumptions"] == ["가정"]
    assert (await load_notes(_ctx(db)))["assumptions"] == []
    await save_json(_ctx(db), "01_agent_x.json", {"a": 1})
    assert await load_json(_ctx(db), "01_agent_x.json") == {"a": 1}
    assert await load_json(_ctx(None), "01_agent_x.json") == {}


def test_budgets_by_plan():
    assert budget_for("pro").reviewers == 2 and budget_for(None) is BUDGETS["FREE"]
    assert budget_for("FREE").reviewers == 0 and not budget_for("FREE").extras
    assert budget_for("EMPLOYER:BASIC").reviewers == 0 and budget_for("EMPLOYER:PRO").reviewers == 2
    assert budget_for("EMPLOYER:UNKNOWN") is BUDGETS["EMPLOYER:BASIC"]
