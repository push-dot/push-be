"""packages/contracts/openapi.json and the FastAPI routes stay in sync."""

from __future__ import annotations

import json
import re
from pathlib import Path

from app.main import app

ROOT = Path(__file__).resolve().parents[3]
SPEC = json.loads((ROOT / "packages/contracts/openapi.json").read_text())


def _shape(path: str) -> str:
    return re.sub(r"\{[^}]*\}", "{}", path)


def _spec_routes(owners: set[str]) -> set[str]:
    return {f"{method.upper()} {_shape(path)}"
            for path, item in SPEC["paths"].items()
            for method, op in item.items() if op["x-owner"] in owners}


def _app_routes() -> set[str]:
    return {f"{method.upper()} {_shape(path)}"
            for path, item in app.openapi()["paths"].items()
            for method in item
            if path.startswith("/api/v1/") or path == "/healthz"}


def test_every_ai_route_in_the_spec_is_mounted():
    assert sorted(_spec_routes({"ai"}) - _app_routes()) == []


def test_every_public_fastapi_route_is_in_the_spec():
    assert sorted(_app_routes() - _spec_routes({"ai", "gateway"})) == []
