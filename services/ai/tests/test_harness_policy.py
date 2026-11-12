import pytest

from app.domain.access_mode import AccessMode
from app.harness.policy import ALWAYS_ASK_TOOLS, Decision, Tier, decide
from app.harness.registry import REGISTRY

_ASK = {
    (AccessMode.ALWAYS_ASK, Tier.EXTERNAL_READ),
    (AccessMode.AUTO, Tier.EXTERNAL_READ),
    (AccessMode.ALWAYS_ASK, Tier.SAFE_WRITE),
    (AccessMode.ALWAYS_ASK, Tier.RISKY_WRITE),
    (AccessMode.AUTO, Tier.RISKY_WRITE),
}


@pytest.mark.parametrize("mode", list(AccessMode))
@pytest.mark.parametrize("tier", list(Tier))
def test_policy_matrix(mode, tier):
    expected = Decision.ASK if (mode, tier) in _ASK else Decision.EXECUTE
    assert decide(mode, tier) is expected


@pytest.mark.parametrize("mode", list(AccessMode))
@pytest.mark.parametrize("tool", sorted(ALWAYS_ASK_TOOLS))
def test_apply_accept_and_stage_change_ask_in_every_mode(mode, tool):
    assert decide(mode, Tier.RISKY_WRITE, tool) is Decision.ASK


def test_always_ask_names_real_tools():
    names = {tool.name for spec in REGISTRY.values() for tool in spec.tools}
    assert ALWAYS_ASK_TOOLS == {"apply_to_posting", "accept_offer", "change_applicant_stage"}
    assert ALWAYS_ASK_TOOLS <= names
