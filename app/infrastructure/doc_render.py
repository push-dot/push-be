from __future__ import annotations

import io
import zipfile
from xml.sax.saxutils import escape


def tiptap_to_lines(doc: dict) -> list[str]:
    lines: list[str] = []
    for node in doc.get("content", []):
        _node_lines(node, lines)
    return lines


def _text(node: dict) -> str:
    if node.get("type") == "text":
        return node.get("text", "")
    return "".join(_text(c) for c in node.get("content", []))


def _node_lines(node: dict, out: list[str], prefix: str = "") -> None:
    t = node.get("type")
    if t == "heading":
        level = node.get("attrs", {}).get("level", 2)
        out.append("#" * min(level, 3) + " " + _text(node))
    elif t == "paragraph":
        out.append(prefix + _text(node))
    elif t == "bulletList":
        for item in node.get("content", []):
            _node_lines(item, out, "- ")
    elif t == "orderedList":
        for i, item in enumerate(node.get("content", []), 1):
            _node_lines(item, out, f"{i}. ")
    elif t == "listItem":
        for c in node.get("content", []):
            _node_lines(c, out, prefix)
    elif t in ("blockquote",):
        for c in node.get("content", []):
            _node_lines(c, out, "> ")
    elif t == "horizontalRule":
        out.append("—" * 20)
    elif t == "hardBreak":
        out.append("")
    else:
        text = _text(node)
        if text:
            out.append(prefix + text)


def render_pdf(md_lines: list[str]) -> bytes:
    from app.infrastructure.resume_workspace import md_to_pdf
    buf = io.BytesIO()
    md_to_pdf("\n".join(md_lines), buf)
    return buf.getvalue()


def render_docx(md_lines: list[str]) -> bytes:
    body = "".join(_docx_paragraph(line) for line in md_lines)
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org'
        '/wordprocessingml/2006/main">'
        f"<w:body>{body}</w:body></w:document>")
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org'
        '/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.'
        'openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/'
        'vnd.openxmlformats-officedocument.wordprocessingml.document.'
        'main+xml"/></Types>')
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org'
        '/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org'
        '/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/></Relationships>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document)
    return buf.getvalue()


def _docx_paragraph(line: str) -> str:
    style = ""
    text = line
    if line.startswith("### "):
        style = "Heading3"
        text = line[4:]
    elif line.startswith("## "):
        style = "Heading2"
        text = line[3:]
    elif line.startswith("# "):
        style = "Heading1"
        text = line[2:]
    if not text:
        return "<w:p/>"
    ppr = (f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>'
           if style else "")
    return (f"<w:p>{ppr}<w:r><w:t xml:space=\"preserve\">"
            f"{escape(text)}</w:t></w:r></w:p>")
