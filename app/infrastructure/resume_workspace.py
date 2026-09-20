from __future__ import annotations
import os
import re
from pathlib import Path

_BLOCK = re.compile(r"```\w*\n# file: ([\w.\-]+)\n(.*?)```", re.DOTALL)
_MARKER = "# file: "


def strip_file_blocks(text: str) -> str:
    return visible_prefix(text).strip()


def visible_prefix(text: str) -> str:
    s = _BLOCK.sub("", text)
    if s.count("```") % 2 == 0:
        return s
    idx = s.rfind("```")
    after = s[idx + 3:]
    nl = after.find("\n")
    if nl == -1:
        return s[:idx]
    content = after[nl + 1:]
    first = content.split("\n", 1)[0]
    if _MARKER.startswith(first) or first.startswith(_MARKER):
        return s[:idx]
    return s


def _root() -> Path:
    return Path(os.environ.get(
        "PUSH_RESUME_DIR", str(Path.home() / ".push-resume")))


_DOC_KINDS = (("cover_letter", "COVER_LETTER", "자기소개서"),
              ("portfolio", "PORTFOLIO", "포트폴리오"),
              ("resume", "RESUME", "이력서"))
_DOC_FILE = re.compile(r"^0[345]_.+\.md$")


def _kind_of(name: str):
    low = name.lower()
    for key, kind, label in _DOC_KINDS:
        if key in low:
            return kind, label
    return "RESUME", "이력서"


def md_to_doc(md: str):
    from app.domain.entities import Block
    nodes, blocks, i = [], [], 0

    def add(kind, extra, txt):
        nonlocal i
        i += 1
        bid = "block-" + str(i)
        nodes.append({"type": kind, "attrs": {"blockId": bid, **extra},
                      "content": [{"type": "text", "text": txt}]})
        blocks.append(Block(id=bid, text=txt))

    for raw in md.splitlines():
        s = raw.rstrip()
        if not s:
            continue
        h = re.match(r"^(#{1,4})\s+(.*)", s)
        li = re.match(r"^\s*[-*]\s+(.*)", s)
        if h:
            add("heading", {"level": len(h.group(1))}, h.group(2))
        elif li:
            add("paragraph", {}, "• " + li.group(1))
        else:
            add("paragraph", {}, s)
    if not nodes:
        add("paragraph", {}, "")
    return {"type": "doc", "content": nodes}, blocks


async def sync_documents(svc, user_id, conv, saved: list[str]) -> None:
    import json
    import logging
    from uuid import UUID
    d = workspace_dir(conv.id, conv.title or "")
    map_file = d / ".docs.json"
    mapping: dict = {}
    if map_file.exists():
        try:
            mapping = json.loads(map_file.read_text())
        except Exception:
            mapping = {}
    changed = False
    for name in saved:
        if not _DOC_FILE.match(name):
            continue
        kind, label = _kind_of(name)
        body = (d / name).read_text()
        content, blocks = md_to_doc(body)
        doc_id = mapping.get(kind)
        try:
            if doc_id:
                doc = await svc.documents.get(user_id, UUID(doc_id))
                await svc.documents.create_version(
                    user_id, doc.id, doc.revision, content, blocks,
                    "chat update " + name)
            else:
                title = (conv.title or "생성 문서") + " " + label
                doc = await svc.documents.create(
                    user_id, None, title, kind, "CLASSIC", "ko")
                await svc.documents.create_version(
                    user_id, doc.id, doc.revision, content, blocks,
                    "chat " + name)
                mapping[kind] = str(doc.id)
                changed = True
        except Exception:
            logging.getLogger(__name__).exception(
                "doc sync failed for %s", name)
    if changed:
        map_file.write_text(json.dumps(mapping))


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
    blocks = _BLOCK.findall(text)
    last_end = max((m.end() for m in _BLOCK.finditer(text)), default=0)
    tail = re.search(r"```\w*\n# file: ([\w.\-]+)\n(.*)$",
                     text[last_end:], re.DOTALL)
    if tail:
        blocks.append((tail.group(1), tail.group(2)))
    for name, body in blocks:
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
