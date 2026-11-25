from __future__ import annotations

from app.harness.status import Run, acting_user, current_run


def test_a_resumed_turn_acts_as_the_member_who_answered():
    state = {"user_id": "opener"}
    assert acting_user(state) == "opener"
    token = current_run.set(Run("job", "", False, user_id="teammate"))
    try:
        assert acting_user(state) == "teammate"
    finally:
        current_run.reset(token)


def test_a_run_without_a_user_keeps_the_state_user():
    token = current_run.set(Run("job", "", False))
    try:
        assert acting_user({"user_id": "opener"}) == "opener"
    finally:
        current_run.reset(token)
