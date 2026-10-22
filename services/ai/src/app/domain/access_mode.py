from __future__ import annotations

from enum import StrEnum


class AccessMode(StrEnum):
    ALWAYS_ASK = "ALWAYS_ASK"
    AUTO = "AUTO"
    BYPASS = "BYPASS"


_LEGACY = {
    "SUGGEST": AccessMode.AUTO,
    "CONFIRM_ACTIONS": AccessMode.ALWAYS_ASK,
}


def normalize_access_mode(raw: str | None) -> AccessMode | None:
    if raw is None:
        return None
    text = raw.strip()
    if text == "":
        return None
    if text in AccessMode.__members__:
        return AccessMode(text)
    mapped = _LEGACY.get(text)
    if mapped is not None:
        return mapped
    raise ValueError(text)


def resolve_access_mode(requested: str | None, saved: str | None) -> AccessMode:
    chosen = normalize_access_mode(requested)
    if chosen is not None:
        return chosen
    try:
        chosen = normalize_access_mode(saved)
    except ValueError:
        chosen = None
    return chosen or AccessMode.AUTO
