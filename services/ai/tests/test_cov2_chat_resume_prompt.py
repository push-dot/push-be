"""graphs/resume_prompt.py: phase detection, gates, and the phase system prompt."""
from __future__ import annotations

from uuid import uuid4

import pytest

from app.graphs import resume_prompt as rp


@pytest.mark.parametrize(("names", "phase"), [
    (["05_final_resume.md", "01_parsed_resume.json"], 6),
    (["04_design.md"], 5),
    (["03_draft.md"], 4),
    (["02_strategy.md"], 3),
    (["01_job_analyses.json"], 2),
    (["01_scenario.json"], 1),
])
def test_phase_from_filenames_takes_the_latest_marker(names, phase):
    assert rp.phase_from_filenames(names) == phase


def test_phase_from_filenames_falls_back_to_history_text():
    assert rp.phase_from_filenames(["notes.txt"], "saved 02_strategy.md") == 3
    assert rp.phase_from_filenames([], "") == 0


def test_resume_phase_reads_the_workspace_before_history(tmp_path, monkeypatch):
    monkeypatch.setenv("PUSH_RESUME_DIR", str(tmp_path))
    from app.infrastructure.resume_workspace import workspace_dir
    conv_id = uuid4()
    d = workspace_dir(conv_id, "지원")
    (d / "03_resume.md").write_text("x")
    assert rp.resume_phase("01_scenario", conv_id, "지원") == 4
    # Empty workspace: history markers decide.
    assert rp.resume_phase("01_tone 저장", uuid4(), "다른") == 1


def test_resume_phase_ignores_an_unreadable_workspace(tmp_path, monkeypatch):
    blocker = tmp_path / "file"
    blocker.write_text("not a dir")
    monkeypatch.setenv("PUSH_RESUME_DIR", str(blocker))
    assert rp.resume_phase("02_x", uuid4(), "t") == 3


def test_gate_for_phase_has_a_question_only_for_known_phases():
    assert "품질 검증" in rp.gate_for_phase(3)
    assert rp.gate_for_phase(0) == ""
    assert rp.gate_for_phase(6) == ""


@pytest.mark.parametrize(("reply", "gate"), [
    ("초안을 작성했습니다.", True),
    ("진행할까요", False),
    ("다음 선택지 중 하나", False),
    ("괜찮나요?  \n", False),
    ("질문?" + "가" * 500, True),
])
def test_needs_gate_only_when_the_reply_tail_asks_nothing(reply, gate):
    assert rp.needs_gate(reply) is gate


def test_wants_resume_flow_signals():
    assert rp.wants_resume_flow("Resume please", "")
    assert rp.wants_resume_flow("hi", "Phase 1 done")
    assert rp.wants_resume_flow("hi", "", ("RESUME",))
    assert not rp.wants_resume_flow("hi", "", ("CAREER",))


def test_resume_system_prompt_targets_the_detected_phase(tmp_path, monkeypatch):
    monkeypatch.setenv("PUSH_RESUME_DIR", str(tmp_path))
    prompt = rp.resume_system_prompt("01_parsed_resume.json 저장됨")
    assert prompt == rp._phase_prompt(2)
    assert "Phase 2: 적합도 분석과 콘텐츠 전략" in prompt
    assert prompt.startswith("[환경 규칙]")
