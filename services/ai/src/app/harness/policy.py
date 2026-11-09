from __future__ import annotations

from enum import StrEnum

from app.domain.access_mode import AccessMode


class Tier(StrEnum):
    READ = "READ"
    SAFE_WRITE = "SAFE_WRITE"
    RISKY_WRITE = "RISKY_WRITE"


class Decision(StrEnum):
    EXECUTE = "EXECUTE"
    ASK = "ASK"


_DECISIONS = {
    (AccessMode.ALWAYS_ASK, Tier.READ): Decision.EXECUTE,
    (AccessMode.ALWAYS_ASK, Tier.SAFE_WRITE): Decision.ASK,
    (AccessMode.ALWAYS_ASK, Tier.RISKY_WRITE): Decision.ASK,
    (AccessMode.AUTO, Tier.READ): Decision.EXECUTE,
    (AccessMode.AUTO, Tier.SAFE_WRITE): Decision.EXECUTE,
    (AccessMode.AUTO, Tier.RISKY_WRITE): Decision.ASK,
    (AccessMode.BYPASS, Tier.READ): Decision.EXECUTE,
    (AccessMode.BYPASS, Tier.SAFE_WRITE): Decision.EXECUTE,
    (AccessMode.BYPASS, Tier.RISKY_WRITE): Decision.EXECUTE,
}


# Actions a person must confirm in every mode, BYPASS included (약관 9조3항).
# core-api/src/internal-auth.ts APPROVAL_ROUTES refuses these without an approved card.
ALWAYS_ASK_TOOLS = frozenset({"apply_to_posting", "accept_offer", "change_applicant_stage"})


def decide(mode: AccessMode, tier: Tier, tool: str | None = None) -> Decision:
    if tool in ALWAYS_ASK_TOOLS:
        return Decision.ASK
    if not isinstance(tier, Tier):
        tier = tier.metadata["tier"]
    return _DECISIONS[(mode, tier)]
