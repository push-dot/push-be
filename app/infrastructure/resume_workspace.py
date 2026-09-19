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
        if re.fullmatch(r"05_final_\w+\.md", name):
            try:
                md_to_pdf(body.strip(), d / (name[:-3] + ".pdf"))
            except Exception:
                import logging
                logging.getLogger(__name__).exception("pdf render failed")
    return saved


def md_to_pdf(md: str, out: Path) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(UnicodeCIDFont("HYGothic-Medium"))
    c = canvas.Canvas(str(out), pagesize=A4)
    width, height = A4
    margin, y = 20 * mm, height - 20 * mm
    max_chars = 42

    def flush_line(line: str, size: int, gap: float) -> None:
        nonlocal y
        for i in range(0, max(len(line), 1), max_chars):
            if y < margin:
                c.showPage()
                y = height - margin
                c.setFont("HYGothic-Medium", size)
            c.setFont("HYGothic-Medium", size)
            c.drawString(margin, y, line[i:i + max_chars])
            y -= size * 1.4 * gap

    for raw in md.splitlines():
        line = raw.rstrip()
        if line.startswith("### "):
            flush_line(line[4:], 13, 1.4)
        elif line.startswith("## "):
            flush_line(line[3:], 15, 1.5)
        elif line.startswith("# "):
            flush_line(line[2:], 19, 1.8)
        elif line.startswith("- ") or line.startswith("* "):
            flush_line("• " + line[2:], 10, 1.2)
        elif not line:
            y -= 6
        else:
            flush_line(line, 10, 1.2)
    c.save()
