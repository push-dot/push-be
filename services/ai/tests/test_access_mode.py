from __future__ import annotations

import pytest

from app.domain.access_mode import AccessMode, normalize_access_mode, resolve_access_mode


def test_legacy_values_map():
    assert normalize_access_mode("SUGGEST") is AccessMode.AUTO
    assert normalize_access_mode("CONFIRM_ACTIONS") is AccessMode.ALWAYS_ASK


def test_resolve_order():
    assert resolve_access_mode(None, "BYPASS") is AccessMode.BYPASS
    assert resolve_access_mode("ALWAYS_ASK", "BYPASS") is AccessMode.ALWAYS_ASK
    assert resolve_access_mode(None, None) is AccessMode.AUTO


def test_unknown_rejected():
    with pytest.raises(ValueError):
        normalize_access_mode("YOLO")


def test_blank_is_none():
    assert normalize_access_mode("") is None
    assert normalize_access_mode("  ") is None
