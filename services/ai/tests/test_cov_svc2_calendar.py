"""calendar._valid_tz is the only live calendar code (InterviewService uses it
to validate interview time zones)."""
from __future__ import annotations

import pytest

from app.domain.services.calendar import _valid_tz


@pytest.mark.parametrize("tz", ["UTC", "Asia/Seoul", "America/New_York"])
def test_valid_iana_zones(tz):
    assert _valid_tz(tz) is True


@pytest.mark.parametrize("tz", ["", "Mars/Base", "../etc/passwd", "/abs/path",
                                "Asia/Seoul\x00"])
def test_invalid_or_hostile_zones_are_rejected(tz):
    assert _valid_tz(tz) is False
