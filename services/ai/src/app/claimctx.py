"""Per-workflow ownership of a chat job.

A cron nudge used to start a second Workflow while the first was still
running. Each run carries a claim token. Writes check it, and a run that
lost the token stops without emitting, recording usage, or changing status.
"""

from contextvars import ContextVar


class LostClaim(Exception):
    """This run no longer owns the chat job."""


claim_token: ContextVar[str] = ContextVar("chat_claim", default="")
claim_job: ContextVar[str] = ContextVar("chat_claim_job", default="")


def bound_claim(job_id) -> str:
    token = claim_token.get()
    if token and claim_job.get() == str(job_id):
        return token
    return ""
