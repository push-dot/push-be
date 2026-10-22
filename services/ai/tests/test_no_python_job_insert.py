from __future__ import annotations

import re
from pathlib import Path

from app.main import app

SRC = Path(__file__).resolve().parents[1] / "src" / "app"


def test_python_exposes_no_chat_message_route():
    paths = {getattr(route, "path", "") for route in app.routes}
    assert not any(re.search(r"/conversations/\{[^}]+\}/messages(/stream)?$", path) for path in paths)


def test_python_never_inserts_ai_jobs():
    offenders = [
        str(path.relative_to(SRC)) for path in SRC.rglob("*.py")
        if re.search(r"INSERT\s+INTO\s+(chat_jobs|ai_jobs)\b", path.read_text(encoding="utf-8"))
    ]
    assert offenders == []
