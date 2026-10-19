from datetime import datetime, timezone

from app import clock


def test_millisecond_float_artifact_steps_up_to_the_boundary(monkeypatch):
    # ...644999µs is what a millisecond clock becomes after a float round trip.
    monkeypatch.setattr(clock.time, "time_ns", lambda: 1_760_852_825 * 1_000_000_000 + 644_999_000)
    got = clock.utcnow()
    assert got == datetime(2025, 10, 19, 5, 47, 5, 645000, tzinfo=timezone.utc)


def test_real_microseconds_stay(monkeypatch):
    monkeypatch.setattr(clock.time, "time_ns", lambda: 1_760_852_825 * 1_000_000_000 + 428_451_000)
    got = clock.utcnow()
    assert got.microsecond == 428451
