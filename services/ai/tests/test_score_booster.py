from app.harness.personal.resume.booster import boost_cycle


def _run(monkeypatch, scores):
    seen = []
    monkeypatch.setattr(
        "app.harness.personal.resume.booster.interrupt",
        lambda payload: seen.append(payload))
    return boost_cycle({"scores": scores}), seen


def test_stops_at_five_cycles(monkeypatch):
    out, seen = _run(monkeypatch, [5.0, 5.1, 5.2, 5.3, 5.4, 5.5, 9.0])
    assert out["stopped"] == "max"
    assert out["cycles"] == 5
    assert out["score"] == 5.5
    assert [step["cycle"] for step in seen] == [1, 2, 3, 4, 5]
    assert seen[-1]["gain"] == 0.1


def test_a_short_score_list_does_not_count_as_the_cap(monkeypatch):
    out, seen = _run(monkeypatch, [5.0, 6.0])
    assert out["stopped"] == "continue"
    assert out["cycles"] == 1
    assert len(seen) == 1


def test_stops_on_two_consecutive_gains_below_a_tenth(monkeypatch):
    out, seen = _run(monkeypatch, [5.0, 5.0, 5.2, 5.2, 5.2, 9.0])
    assert out["stopped"] == "stall"
    assert out["cycles"] == 4
    assert out["score"] == 5.2
    assert [step["gain"] for step in seen] == [0.0, 0.2, 0.0, 0.0]
