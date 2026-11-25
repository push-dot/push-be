from __future__ import annotations

from app.harness.kstyle.final import Final, late_lines, render


def test_fixed_order_and_caps():
    text = render(Final(made=["a", "b", "c", "d"], decided=["x"], left=["l1", "l2", "l3", "l4"], next="n"))
    assert text == ("만든 것\n• a\n• b\n• c\n\n대신 정한 것\n• x\n\n"
                    "확인이 필요한 점\n• l1\n• l2\n• l3\n• l4\n\n다음\n• n")


def test_empty_sections_are_omitted():
    assert render(Final(made=["a"], decided=[" "], next="")) == "만든 것\n• a"
    assert render(Final()) == ""


def test_late_lines_use_labels():
    assert late_lines(["company", "other"], {"company": "회사 조사"}) == [
        "회사 조사: 시간 안에 끝나지 않아 빼고 진행했어요", "other: 시간 안에 끝나지 않아 빼고 진행했어요"]


def test_the_newest_assumptions_show():
    assert render(Final(decided=["a1", "a2", "a3", "a4"])) == "대신 정한 것\n• a2\n• a3\n• a4"
