from __future__ import annotations
import asyncio
import os
import re
from pathlib import Path
from uuid import UUID

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


_DOC_KINDS = (("career_statement", "CAREER_STATEMENT", "경력기술서"),
              ("cover_letter", "COVER_LETTER", "자기소개서"),
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


async def sync_documents(svc, user_id, conv,
                         saved: list[str]) -> list[dict]:
    if _db_blobs():
        return await _sync_documents_db(svc, user_id, conv, saved)
    import json
    import logging
    d = await asyncio.to_thread(workspace_dir, conv.id, conv.title or "")
    map_file = d / ".docs.json"
    mapping: dict = await asyncio.to_thread(_load_mapping, map_file)
    if getattr(svc, "document_svc", None) is None:
        return []
    docs = svc.document_svc
    changed = False
    synced: list[dict] = []
    for name in saved:
        if not _DOC_FILE.match(name):
            continue
        kind, label = _kind_of(name)
        body = await asyncio.to_thread((d / name).read_text)
        content, blocks = md_to_doc(body)
        doc_id = mapping.get(kind)
        try:
            if doc_id:
                doc = await docs.get(user_id, UUID(doc_id))
                _, v = await docs.create_version(
                    user_id, doc.id, doc.revision, content, blocks,
                    "chat update " + name)
            else:
                base = (conv.title or "").strip()
                if base in ("", "새 채팅", "New chat"):
                    base = (await asyncio.to_thread(_company_label, d)
                            or "생성 문서")
                title = base + " " + label
                doc = await docs.create(
                    user_id, None, title, kind, "CLASSIC", "ko")
                _, v = await docs.create_version(
                    user_id, doc.id, doc.revision, content, blocks,
                    "chat " + name)
                mapping[kind] = str(doc.id)
                changed = True
            synced.append({"document_id": doc.id, "version_id": v.id,
                           "title": doc.title})
        except Exception:
            logging.getLogger(__name__).exception(
                "doc sync failed for %s", name)
    if changed:
        await asyncio.to_thread(map_file.write_text, json.dumps(mapping))
    return synced


def _load_mapping(map_file: Path) -> dict:
    import json
    if map_file.exists():
        try:
            return json.loads(map_file.read_text())
        except Exception:
            return {}
    return {}


def _company_label(d: Path) -> str:
    import json
    f = d / "01_job_analyses.json"
    try:
        data = json.loads(f.read_text())
        items = data if isinstance(data, list) else [data]
        for it in items:
            name = (it.get("company") or {}).get("name") or ""
            if name.strip():
                return name.strip()
    except Exception:
        pass
    return ""


def _slug(title: str) -> str:
    s = re.sub(r"[^\w가-힣\-]+", "-", title).strip("-").lower()
    return s[:40] or "chat"


def workspace_dir(conversation_id, title: str = "") -> Path:
    # Keyed by the full id: the old "<title slug>-<8 hex>" name moved when the
    # title changed and could be shared by two users' conversations.
    d = _root() / str(UUID(str(conversation_id)))
    if not d.exists():
        # shortcut: adopts the pre-fix directory only while the title is unchanged; delete after 2026-12
        legacy = _root() / (_slug(title) + "-" + str(conversation_id)[:8])
        if legacy.is_dir():
            legacy.rename(d)
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
        existing = d / tail.group(1)
        if not existing.exists() or \
                existing.stat().st_size < len(tail.group(2)):
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


def _db_blobs() -> bool:
    return os.environ.get("BLOB_STORE") == "db"


async def save_artifacts_db(db, conversation_id, title: str, text: str) -> list[str]:
    saved = []
    blocks = list(_BLOCK.findall(text))
    last_end = max((m.end() for m in _BLOCK.finditer(text)), default=0)
    tail = re.search(r"```\w*\n# file: ([\w.\-]+)\n(.*)$",
                     text[last_end:], re.DOTALL)
    if tail:
        blocks.append((tail.group(1), tail.group(2)))
    for name, body in blocks:
        if name.startswith(".") or "/" in name or "\\" in name:
            continue
        payload = body.strip() + "\n"
        await db.q().execute(
            "INSERT INTO workspace_files (conversation_id, name, body, updated_at) "
            "VALUES ($1,$2,$3,now()) "
            "ON CONFLICT (conversation_id, name) DO UPDATE "
            "SET body=EXCLUDED.body, updated_at=now()",
            conversation_id, name, payload)
        saved.append(name)
        if re.fullmatch(r"05_final_\w+\.md", name):
            try:
                import io
                buf = io.BytesIO()
                md_to_pdf(payload, buf)
                await db.q().execute(
                    "INSERT INTO workspace_files "
                    "(conversation_id, name, content, updated_at) "
                    "VALUES ($1,$2,$3,now()) "
                    "ON CONFLICT (conversation_id, name) DO UPDATE "
                    "SET content=EXCLUDED.content, updated_at=now()",
                    conversation_id, name[:-3] + ".pdf", buf.getvalue())
            except Exception:
                import logging
                logging.getLogger(__name__).exception("pdf render failed")
    return saved


async def artifact_names(db, conversation_id) -> set[str]:
    rows = await db.q().fetch(
        "SELECT name FROM workspace_files WHERE conversation_id=$1",
        conversation_id)
    return {r["name"] for r in rows}


async def read_artifact(db, conversation_id, name: str) -> str:
    row = await db.q().fetchrow(
        "SELECT body FROM workspace_files WHERE conversation_id=$1 AND name=$2",
        conversation_id, name)
    if row is None or row["body"] is None:
        return ""
    return row["body"]


def md_to_pdf(md: str, out, template: str | None = None) -> None:
    if template:
        from app.domain.entities.documents import stored_document_template
        md = f"{md.rstrip()}\n{stored_document_template(template)}"
    try:
        _md_to_pdf_reportlab(md, out)
    except Exception:
        _md_to_pdf_plain(md, out)


def _md_to_pdf_reportlab(md: str, out) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(UnicodeCIDFont("HYGothic-Medium"))
    c = canvas.Canvas(out if hasattr(out, "write") else str(out),
                      pagesize=A4)
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


def _md_to_pdf_plain(md: str, out) -> None:
    """CID PDF using the same HYGothic-Medium face ReportLab references.

    The font is not embedded (Workers have no CJK font files). Viewers that
    ship a Korean substitute, including Acrobat, still render the text.
    """
    width, height = 595, 842
    margin, size, leading = 56, 11, 16
    max_chars = 42
    pages: list[list[str]] = [[]]
    y = height - margin

    def add(line: str, sz: int) -> None:
        nonlocal y
        text = line or " "
        for i in range(0, max(len(text), 1), max_chars):
            if y < margin:
                pages.append([])
                y = height - margin
            pages[-1].append((text[i:i + max_chars], sz, y))
            y -= leading

    for raw in md.splitlines():
        line = raw.rstrip()
        if line.startswith("### "):
            add(line[4:], 13)
        elif line.startswith("## "):
            add(line[3:], 15)
        elif line.startswith("# "):
            add(line[2:], 18)
        elif line.startswith("- ") or line.startswith("* "):
            add("• " + line[2:], size)
        elif not line:
            y -= 8
        else:
            add(line, size)
    if not pages[-1]:
        pages[-1].append(("", size, height - margin))

    objects: list[bytes] = []

    def add_obj(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    font_desc = add_obj(
        b"<< /Type /FontDescriptor /FontName /HYGothic-Medium /Flags 4 "
        b"/FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 "
        b"/Descent -120 /CapHeight 700 /StemV 80 >>")
    cid = add_obj(
        f"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYGothic-Medium "
        f"/CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> "
        f"/FontDescriptor {font_desc} 0 R >>".encode())
    font = add_obj(
        f"<< /Type /Font /Subtype /Type0 /BaseFont /HYGothic-Medium "
        f"/Encoding /UniKS-UCS2-H /DescendantFonts [{cid} 0 R] >>".encode())
    contents = []
    for lines in pages:
        stream = ["BT", f"/F1 {size} Tf"]
        for text, sz, yy in lines:
            hexs = text.encode("utf-16-be").hex().upper()
            stream.append(f"/F1 {sz} Tf 1 0 0 1 {margin} {int(yy)} Tm <{hexs}> Tj")
        stream.append("ET")
        raw = "\n".join(stream).encode("latin1", errors="replace")
        contents.append(add_obj(
            f"<< /Length {len(raw)} >>\nstream\n".encode() + raw + b"\nendstream"))
    kids = []
    for content_id in contents:
        kids.append(add_obj(
            f"<< /Type /Page /Parent {{PAGES}} 0 R /MediaBox [0 0 {width} {height}] "
            f"/Contents {content_id} 0 R /Resources << /Font << /F1 {font} 0 R >> >> >>"
            .encode()))
    kids_ref = " ".join(f"{k} 0 R" for k in kids)
    pages_id = add_obj(
        f"<< /Type /Pages /Count {len(kids)} /Kids [{kids_ref}] >>".encode())
    for k in kids:
        objects[k - 1] = objects[k - 1].replace(b"{PAGES}", str(pages_id).encode())
    catalog = add_obj(f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode())
    out_buf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for i, body in enumerate(objects, 1):
        offsets.append(len(out_buf))
        out_buf += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out_buf)
    out_buf += f"xref\n0 {len(objects) + 1}\n".encode()
    out_buf += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out_buf += f"{off:010d} 00000 n \n".encode()
    out_buf += (
        f"trailer << /Size {len(objects) + 1} /Root {catalog} 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n").encode()
    data = bytes(out_buf)
    if hasattr(out, "write"):
        out.write(data)
    else:
        from pathlib import Path
        Path(out).write_bytes(data)


async def _sync_documents_db(
    svc, user_id, conv, saved: list[str], template: str | None = None,
) -> list[dict]:
    import json
    import logging
    raw = await read_artifact(svc.db, conv.id, ".docs.json")
    try:
        mapping = json.loads(raw) if raw else {}
    except Exception:
        mapping = {}
    if not isinstance(mapping, dict):
        mapping = {}
    if getattr(svc, "document_svc", None) is None:
        return []
    docs = svc.document_svc
    changed = False
    synced: list[dict] = []
    for name in saved:
        if not _DOC_FILE.match(name):
            continue
        kind, label = _kind_of(name)
        body = await read_artifact(svc.db, conv.id, name)
        content, blocks = md_to_doc(body)
        doc_id = mapping.get(kind)
        try:
            if doc_id:
                doc = await docs.get(user_id, UUID(doc_id))
                if template is not None and hasattr(docs, "set_template"):
                    doc = await docs.set_template(
                        user_id, doc.id, doc.revision, template)
                _, v = await docs.create_version(
                    user_id, doc.id, doc.revision, content, blocks,
                    "chat update " + name)
            else:
                base = (conv.title or "").strip()
                if base in ("", "새 채팅", "New chat"):
                    base = await _company_label_db(svc.db, conv.id) or "생성 문서"
                title = base + " " + label
                doc = await docs.create(
                    user_id, None, title, kind, template or "CLASSIC", "ko")
                _, v = await docs.create_version(
                    user_id, doc.id, doc.revision, content, blocks,
                    "chat " + name)
                mapping[kind] = str(doc.id)
                changed = True
            synced.append({"document_id": doc.id, "version_id": v.id,
                           "title": doc.title})
        except Exception:
            logging.getLogger(__name__).exception(
                "doc sync failed for %s", name)
    if changed:
        await svc.db.q().execute(
            "INSERT INTO workspace_files (conversation_id, name, body, updated_at) "
            "VALUES ($1,$2,$3,now()) "
            "ON CONFLICT (conversation_id, name) DO UPDATE "
            "SET body=EXCLUDED.body, updated_at=now()",
            conv.id, ".docs.json", json.dumps(mapping))
    return synced


async def _company_label_db(db, conversation_id) -> str:
    import json
    raw = await read_artifact(db, conversation_id, "01_job_analyses.json")
    try:
        data = json.loads(raw) if raw else None
        items = data if isinstance(data, list) else [data]
        for it in items:
            if not isinstance(it, dict):
                continue
            name = (it.get("company") or {}).get("name") or ""
            if name.strip():
                return name.strip()
    except Exception:
        pass
    return ""
