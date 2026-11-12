"""What a reopened bot chat shows: the frames its stream sent, kept small once the turn is over."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.domain.chat_turns import bot_turn_events, compaction

T0 = datetime(2026, 11, 13, tzinfo=UTC)
CARD = "00000000-0000-4000-8000-00000000c0de"


def _row(id_, type_, payload):
    return {"id": id_, "type": type_, "payload": payload, "created_at": T0 + timedelta(seconds=id_)}


def _status(id_, phase, text="생각 중", **fields):
    return _row(id_, "status", {"text": text, "phase": phase, "since": "2026-11-13T00:00:00Z", **fields})


def _compacted(rows):
    merged, dropped = compaction(rows)
    kept = [row for row in rows if row["id"] not in dropped]
    return [{**row, "payload": {**row["payload"], "text": merged[row["id"]]}} if row["id"] in merged else row
            for row in kept]


TOOL_BETWEEN_TEXTS = [
    _status(1, "queued", "대기 중", ahead=0),
    _status(2, "thinking"),
    _row(3, "token", {"text": "공고를 "}),
    _status(4, "thinking"),
    _row(5, "token", {"text": "볼게요"}),
    _row(6, "tool", {"name": "read_posting", "state": "run", "summary": "공고 읽기"}),
    _status(7, "working", "공고를 읽는 중"),
    _row(8, "tool", {"name": "read_posting", "state": "ok", "summary": "공고 읽기"}),
    _row(9, "token", {"text": "다 "}),
    _row(10, "token", {"text": "읽었어요"}),
    _row(11, "done", {"operation": None}),
]


def test_text_split_by_a_tool_call_stays_two_bubbles_before_and_after_compaction():
    texts = [e["text"] for e in bot_turn_events(TOOL_BETWEEN_TEXTS, {}, active=False) if e["type"] == "token"]
    assert texts == ["공고를 볼게요", "다 읽었어요"]
    assert bot_turn_events(_compacted(TOOL_BETWEEN_TEXTS), {}, active=False) == bot_turn_events(
        TOOL_BETWEEN_TEXTS, {}, active=False)


def test_a_piece_of_text_is_stored_at_its_last_row_so_reattaching_after_it_replays_nothing():
    first = bot_turn_events(TOOL_BETWEEN_TEXTS, {}, active=False)[0]
    assert first == {"type": "token", "text": "공고를 볼게요", "seq": 5, "at": T0 + timedelta(seconds=5)}


def test_an_active_turn_replays_its_status_rows_and_a_finished_one_drops_them():
    running = TOOL_BETWEEN_TEXTS[:8]
    assert [e["type"] for e in bot_turn_events(running, {}, active=True)] == [
        "status", "status", "status", "token", "tool", "status", "tool"]
    assert [e["type"] for e in bot_turn_events(TOOL_BETWEEN_TEXTS, {}, active=False)] == [
        "token", "tool", "tool", "token"]


def test_a_status_without_a_phase_is_not_replayed_because_the_bot_stream_never_sent_it():
    rows = [_row(1, "status", {"text": "대기 중"}), _status(2, "thinking")]
    assert [e["seq"] for e in bot_turn_events(rows, {}, active=True)] == [2]


def test_only_the_first_terminal_event_is_kept():
    rows = [
        _row(1, "token", {"text": "쓰는 중"}),
        _row(2, "cancelled", {"resumable": True}),
        _row(3, "cancelled", {"by": "worker"}),
        _row(4, "token", {"text": "늦은 글자"}),
    ]
    assert bot_turn_events(rows, {}, active=False)[1:] == [
        {"type": "cancelled", "resumable": True, "seq": 2, "at": T0 + timedelta(seconds=2)}]


def test_a_finished_turn_keeps_the_wait_and_its_card_reads_the_cards_row():
    opened = T0 + timedelta(minutes=30)
    card = {"resolution": {"status": "EXPIRED", "optionId": None}, "openedAt": opened,
            "expiresAt": opened + timedelta(minutes=10), "retryable": True}
    rows = [
        _status(1, "thinking"),
        _status(2, "waiting", "확인을 기다리고 있어요", **{"for": "confirm", "cardId": CARD}),
        _row(3, "approval", {"id": CARD, "kind": "TOOL_ACTION", "title": "페이지 읽기", "options": []}),
        _row(4, "done", {"operation": None, "awaiting": "approval"}),
    ]
    wait, approval = bot_turn_events(rows, {CARD: card}, active=False)
    assert wait["phase"] == "waiting" and wait["since"] == opened
    assert approval == {"type": "approval", "id": CARD, "kind": "TOOL_ACTION", "title": "페이지 읽기",
                        "options": [], **card, "seq": 3, "at": T0 + timedelta(seconds=3)}


def test_a_gate_the_server_answered_itself_has_no_row_and_reads_as_settled():
    rows = [_row(1, "choice", {"id": CARD, "auto": True, "options": []})]
    (choice,) = bot_turn_events(rows, {}, active=False)
    assert choice["resolution"] == {"status": "APPROVED", "optionId": None}
    assert (choice["openedAt"], choice["expiresAt"], choice["retryable"]) == (T0 + timedelta(seconds=1), None, False)


def test_compaction_of_a_200_token_turn_leaves_one_row_with_the_same_text():
    rows = [_status(1, "thinking")]
    for i in range(200):
        rows.append(_row(2 + 2 * i, "token", {"text": f"{i},"}))
        rows.append(_status(3 + 2 * i, "thinking"))
    rows.append(_row(1000, "done", {"operation": None}))
    left = _compacted(rows)
    tokens = [row for row in left if row["type"] == "token"]
    assert len(tokens) == 1
    assert tokens[0]["payload"]["text"] == "".join(f"{i}," for i in range(200))
    assert [row["type"] for row in left] == ["token", "done"]


def test_compaction_is_idempotent():
    once = _compacted(TOOL_BETWEEN_TEXTS)
    assert compaction(once) == ({}, [])
