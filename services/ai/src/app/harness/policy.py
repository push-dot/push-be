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


class Exposure(StrEnum):
    """How close text the user did not write (a page, another person's writing, an upload) sits to
    a tool call. Such text may carry instructions, so the model's call may be the text's, not the
    user's."""

    NONE = "NONE"
    # In view but not from this run: an earlier turn's tool result, the thread summary, or
    # other users' templates in the system prompt.
    THREAD = "THREAD"
    # A tool result of this run, after the user's last message.
    RUN = "RUN"


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

# Applied at once; the app shows what changed and lets the person 되돌리기 (rule 39). Nothing leaves
# Push and the change can be put back, so no card asks first.
APPLY_THEN_REVIEW = frozenset({"update_my_profile"})

# Reads whose results hold only what the user or their own company wrote.
TRUSTED_READS = frozenset({
    "get_my_profile", "get_company", "get_applicant_counts", "list_company_postings"})

# Writes that only open a guided flow; each step that changes something asks on its own.
FLOW_STARTS = frozenset({"start_document", "start_posting"})


def _held(tier: Tier, tool: str | None, exposure: Exposure) -> bool:
    """A write the user may not have asked for waits for them: every write after untrusted text
    in the same run, and a write that reaches other people while such text is in the thread."""
    if tier not in _WRITES or tool in FLOW_STARTS:
        return False
    if exposure is Exposure.RUN:
        return True
    return exposure is Exposure.THREAD and (tier is Tier.RISKY_WRITE or tool in APPLY_THEN_REVIEW)


def decide(
    mode: AccessMode, tier: Tier, tool: str | None = None, *,
    quick_start: bool = False, supplied: bool = False, granted: bool = False,
    exposure: Exposure = Exposure.NONE,
) -> Decision:
    """supplied: the user gave this URL in the thread. granted: the bot holds a grant for its
    host."""
    if tool in ALWAYS_ASK_TOOLS:
        return Decision.ASK
    if not isinstance(tier, Tier):
        tier = tier.metadata["tier"]
    if _held(tier, tool, exposure):
        return Decision.ASK
    if tier is Tier.EXTERNAL_READ and (supplied or granted):
        return Decision.EXECUTE
    if tool in APPLY_THEN_REVIEW and mode is not AccessMode.ALWAYS_ASK:
        return Decision.EXECUTE
    if quick_start and tier is Tier.RISKY_WRITE:
        return Decision.ASK
    return _DECISIONS[(mode, tier)]
