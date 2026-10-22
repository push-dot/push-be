_STEPS = (30, 120, 600, 3600)


def backoff_seconds(attempt: int) -> int:
    index = max(0, min(attempt, len(_STEPS)) - 1)
    return _STEPS[index]
