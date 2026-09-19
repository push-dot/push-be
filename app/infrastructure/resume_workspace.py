from __future__ import annotations
import os
import re
from pathlib import Path

_BLOCK = re.compile(r"```\w*\n# file: ([\w.\-]+)\n(.*?)```", re.DOTALL)


def _root() -> Path:
    return Path(os.environ.get(
        "PUSH_RESUME_DIR", str(Path.home() / ".push-resume")))


def _slug(title: str) -> str:
    s = re.sub(r"[^\w가-힣\-]+", "-", title).strip("-").lower()
    return s[:40] or "chat"


def workspace_dir(conversation_id, title: str = "") -> Path:
    d = _root() / (_slug(title) + "-" + str(conversation_id)[:8])
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_artifacts(conversation_id, title: str, text: str) -> list[str]:
    saved = []
    d = workspace_dir(conversation_id, title)
    for name, body in _BLOCK.findall(text):
        if name.startswith(".") or "/" in name or "\\" in name:
            continue
        (d / name).write_text(body.strip() + "\n")
        saved.append(name)
    return saved
