import pytest

from app.domain.access_mode import AccessMode
from app.harness.policy import Decision, Tier, decide

_ASK = {
    (AccessMode.ALWAYS_ASK, Tier.SAFE_WRITE),
    (AccessMode.ALWAYS_ASK, Tier.RISKY_WRITE),
    (AccessMode.AUTO, Tier.RISKY_WRITE),
}


@pytest.mark.parametrize("mode", list(AccessMode))
@pytest.mark.parametrize("tier", list(Tier))
def test_policy_matrix(mode, tier):
    expected = Decision.ASK if (mode, tier) in _ASK else Decision.EXECUTE
    assert decide(mode, tier) is expected
