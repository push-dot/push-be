from __future__ import annotations

import pytest

from app.db import (
    _DEFAULT_CHECKPOINTER_POOL_MAX_SIZE,
    _DEFAULT_POOL_MAX_SIZE,
    _DEFAULT_POOL_MIN_SIZE,
    asyncpg_pool_config,
    checkpointer_pool_config,
    neon_pool_max_size,
)


def test_asyncpg_pool_defaults(monkeypatch):
    monkeypatch.delenv("DB_POOL_MIN_SIZE", raising=False)
    monkeypatch.delenv("DB_POOL_MAX_SIZE", raising=False)
    cfg = asyncpg_pool_config()
    assert cfg == {
        "min_size": _DEFAULT_POOL_MIN_SIZE,
        "max_size": _DEFAULT_POOL_MAX_SIZE,
    }
    assert neon_pool_max_size() == _DEFAULT_POOL_MAX_SIZE


def test_asyncpg_pool_from_env(monkeypatch):
    monkeypatch.setenv("DB_POOL_MIN_SIZE", "2")
    monkeypatch.setenv("DB_POOL_MAX_SIZE", "20")
    assert asyncpg_pool_config() == {"min_size": 2, "max_size": 20}
    assert neon_pool_max_size() == 20


def test_asyncpg_pool_rejects_min_above_max(monkeypatch):
    monkeypatch.setenv("DB_POOL_MIN_SIZE", "11")
    monkeypatch.setenv("DB_POOL_MAX_SIZE", "10")
    with pytest.raises(ValueError, match="DB_POOL_MIN_SIZE"):
        asyncpg_pool_config()


def test_asyncpg_pool_rejects_non_integer(monkeypatch):
    monkeypatch.setenv("DB_POOL_MAX_SIZE", "lots")
    with pytest.raises(ValueError, match="DB_POOL_MAX_SIZE"):
        asyncpg_pool_config()


def test_asyncpg_pool_rejects_negative(monkeypatch):
    monkeypatch.setenv("DB_POOL_MIN_SIZE", "-1")
    with pytest.raises(ValueError, match="DB_POOL_MIN_SIZE"):
        asyncpg_pool_config()


def test_checkpointer_pool_max_from_env(monkeypatch):
    monkeypatch.delenv("CHECKPOINTER_POOL_MAX_SIZE", raising=False)
    cfg = checkpointer_pool_config()
    assert cfg["max_size"] == _DEFAULT_CHECKPOINTER_POOL_MAX_SIZE
    monkeypatch.setenv("CHECKPOINTER_POOL_MAX_SIZE", "8")
    assert checkpointer_pool_config()["max_size"] == 8


def test_asyncpg_pool_rejects_zero_max(monkeypatch):
    monkeypatch.setenv("DB_POOL_MAX_SIZE", "0")
    with pytest.raises(ValueError, match="DB_POOL_MAX_SIZE must be >= 1"):
        asyncpg_pool_config()
    with pytest.raises(ValueError, match="DB_POOL_MAX_SIZE must be >= 1"):
        neon_pool_max_size()


def test_checkpointer_pool_rejects_zero_max(monkeypatch):
    monkeypatch.setenv("CHECKPOINTER_POOL_MAX_SIZE", "0")
    with pytest.raises(ValueError, match="CHECKPOINTER_POOL_MAX_SIZE must be >= 1"):
        checkpointer_pool_config()
