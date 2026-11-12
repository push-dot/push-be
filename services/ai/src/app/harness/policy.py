from __future__ import annotations

from enum import StrEnum

from app.domain.access_mode import AccessMode


class Tier(StrEnum):
    READ = "READ"
    # Opens a page outside Push. It asks unless the user gave the URL or the bot holds a grant
    # for its host.
    EXTERNAL_READ = "EXTERNAL_READ"
    SAFE_WRITE = "SAFE_WRITE"
    RISKY_WRITE = "RISKY_WRITE"


class Decision(StrEnum):
    EXECUTE = "EXECUTE"
    ASK = "ASK"


_DECISIONS = {
    (AccessMode.ALWAYS_ASK, Tier.READ): Decision.EXECUTE,
    (AccessMode.ALWAYS_ASK, Tier.EXTERNAL_READ): Decision.ASK,
    (AccessMode.ALWAYS_ASK, Tier.SAFE_WRITE): Decision.ASK,
    (AccessMode.ALWAYS_ASK, Tier.RISKY_WRITE): Decision.ASK,
    (AccessMode.AUTO, Tier.READ): Decision.EXECUTE,
    (AccessMode.AUTO, Tier.EXTERNAL_READ): Decision.ASK,
    (AccessMode.AUTO, Tier.SAFE_WRITE): Decision.EXECUTE,
    (AccessMode.AUTO, Tier.RISKY_WRITE): Decision.ASK,
    (AccessMode.BYPASS, Tier.READ): Decision.EXECUTE,
    (AccessMode.BYPASS, Tier.EXTERNAL_READ): Decision.EXECUTE,
    (AccessMode.BYPASS, Tier.SAFE_WRITE): Decision.EXECUTE,
    (AccessMode.BYPASS, Tier.RISKY_WRITE): Decision.EXECUTE,
}


# Actions a person must confirm in every mode, BYPASS included (약관 9조3항).
# core-api/src/internal-auth.ts APPROVAL_ROUTES refuses these without an approved card.
ALWAYS_ASK_TOOLS = frozenset({"apply_to_posting", "accept_offer", "change_applicant_stage"})


_WRITES = frozenset({Tier.SAFE_WRITE, Tier.RISKY_WRITE})


def decide(
    mode: AccessMode, tier: Tier, tool: str | None = None, *,
    quick_start: bool = False, supplied: bool = False, granted: bool = False,
) -> Decision:
    """supplied: the user gave this URL in the thread. granted: the bot holds a grant for its
    host."""
    if tool in ALWAYS_ASK_TOOLS:
        return Decision.ASK
    if not isinstance(tier, Tier):
        tier = tier.metadata["tier"]
    if tier is Tier.EXTERNAL_READ and (supplied or granted):
        return Decision.EXECUTE
    if quick_start and tier in _WRITES:
        return Decision.ASK
    return _DECISIONS[(mode, tier)]
