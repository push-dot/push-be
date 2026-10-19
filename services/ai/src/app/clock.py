"""UTC clock that does not store a millisecond as ``...999`` microseconds."""

from __future__ import annotations

import time
from datetime import datetime, timezone


def utcnow() -> datetime:
    """Now in UTC.

    ``datetime.fromtimestamp(time.time())`` runs a millisecond clock through
    a binary float. The fraction lands one microsecond under the next
    millisecond, so rows are stored as ``...644999``. ``time.time_ns`` keeps
    an integer count. A remainder of 999 microseconds is that artifact and
    moves up to the millisecond boundary.
    """
    ns = time.time_ns()
    seconds, nanos = divmod(ns, 1_000_000_000)
    micros = nanos // 1000
    if micros % 1000 == 999:
        micros += 1
        if micros == 1_000_000:
            seconds += 1
            micros = 0
    return datetime.fromtimestamp(seconds, timezone.utc).replace(microsecond=micros)
