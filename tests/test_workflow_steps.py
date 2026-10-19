"""Workflow steps stay idempotent when a free-plan CPU limit kills one."""

from app.domain.services.conversation import (
    WORKFLOW_NODES,
    step_already_done,
    step_fail_limit_reached,
)
from worker import WORKFLOW_STEP_PLAN, _NODE_TIMEOUTS, _step_config


def test_every_workflow_node_has_a_timeout():
    assert tuple(_NODE_TIMEOUTS) == WORKFLOW_NODES


def test_claim_and_context_share_one_step():
    assert [name for name, _nodes, _timeout in WORKFLOW_STEP_PLAN] == [
        "prepare", "generate_reply", "persist"]
    assert WORKFLOW_STEP_PLAN[0][1] == ("resolve_context", "prepare_reply")
    assert WORKFLOW_STEP_PLAN[1][2] == "3 minutes"
    assert WORKFLOW_STEP_PLAN[2][2] == "1 minute"


def test_step_retry_uses_exponential_backoff():
    cfg = _step_config("2 minutes")
    assert cfg["timeout"] == "2 minutes"
    assert cfg["retries"]["limit"] == 5
    assert cfg["retries"]["delay"] == "2 seconds"
    assert cfg["retries"]["backoff"] == "exponential"


def test_completed_step_is_not_repeated():
    ck = {"node": "prepare_reply", "event_id": 4, "fails": 0}
    assert step_already_done(ck, "resolve_context")
    assert step_already_done(ck, "prepare_reply")
    assert not step_already_done(ck, "generate_reply")
    assert not step_already_done({}, "resolve_context")
    assert not step_already_done({"node": "nope"}, "persist")


def test_three_failures_stop_the_step():
    assert not step_fail_limit_reached({"fails": 2})
    assert step_fail_limit_reached({"fails": 3})
    assert not step_fail_limit_reached(None)
    assert not step_fail_limit_reached({"fails": "nope"})
