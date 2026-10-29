from __future__ import annotations

from pathlib import Path

_REFERENCES = Path(__file__).resolve().parents[2] / "resources" / "super-resume" / "references"


def personal_prompt() -> str:
    rules = Path(__file__).with_name("prompt.md").read_text(encoding="utf-8").strip()
    core = (_REFERENCES / "core.md").read_text(encoding="utf-8").strip()
    voice = (_REFERENCES / "writing-voice.md").read_text(encoding="utf-8").strip()
    return f"{rules}\n\n{core}\n\n{voice}\n"
