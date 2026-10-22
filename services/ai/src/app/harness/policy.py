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


def decide(mode: AccessMode, tier: Tier) -> Decision:
    return _DECISIONS[(mode, tier)]
