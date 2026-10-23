from __future__ import annotations

import io
import struct
import zipfile
import zlib
from xml.etree import ElementTree as ET

from pypdf import PdfReader

from app.infrastructure import doc_render
from app.infrastructure.doc_render import render_docx, render_pdf, tiptap_to_lines
from app.infrastructure.images import image_bytes, media_type

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _png() -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00"))
            + chunk(b"IEND", b""))


def _t(text: str) -> dict:
    return {"type": "text", "text": text}


# --- tiptap_to_lines ------------------------------------------------------------

def test_tiptap_to_lines_renders_every_node_type():
    doc = {"type": "doc", "content": [
        {"type": "heading", "attrs": {"level": 1}, "content": [_t("Name")]},
        {"type": "heading", "attrs": {"level": 5}, "content": [_t("Deep")]},
        {"type": "heading", "content": [_t("Default")]},
        {"type": "paragraph", "content": [_t("Hello "), _t("world")]},
        {"type": "bulletList", "content": [
            {"type": "listItem", "content": [
                {"type": "paragraph", "content": [_t("first")]}]},
            {"type": "listItem", "content": [
                {"type": "paragraph", "content": [_t("second")]}]}]},
        {"type": "orderedList", "content": [
            {"type": "listItem", "content": [
                {"type": "paragraph", "content": [_t("one")]}]},
            {"type": "listItem", "content": [
                {"type": "paragraph", "content": [_t("two")]}]}]},
        {"type": "blockquote", "content": [
            {"type": "paragraph", "content": [_t("quoted")]}]},
        {"type": "horizontalRule"},
        {"type": "hardBreak"},
        {"type": "codeBlock", "content": [_t("print(1)")]},
        {"type": "image"},
    ]}
    assert tiptap_to_lines(doc) == [
        "# Name", "### Deep", "## Default", "Hello world",
        "- first", "- second", "1. one", "2. two", "> quoted",
        "—" * 20, "", "print(1)",
    ]


def test_tiptap_to_lines_empty_doc():
    assert tiptap_to_lines({"type": "doc"}) == []


# --- render_docx ----------------------------------------------------------------

def test_render_docx_builds_valid_package_with_styles_and_escaping():
    data = render_docx(["# Title", "## Sub", "### Small", "", "a < b & \"c\""])
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        assert set(z.namelist()) == {
            "[Content_Types].xml", "_rels/.rels", "word/document.xml"}
        root = ET.fromstring(z.read("word/document.xml"))
        ET.fromstring(z.read("[Content_Types].xml"))
        ET.fromstring(z.read("_rels/.rels"))
    paras = root.find(f"{_W}body").findall(f"{_W}p")
    styles = [(p.find(f"{_W}pPr/{_W}pStyle").get(f"{_W}val")
               if p.find(f"{_W}pPr") is not None else None) for p in paras]
    texts = ["".join(t.text or "" for t in p.iter(f"{_W}t")) for p in paras]
    assert styles == ["Heading1", "Heading2", "Heading3", None, None]
    assert texts == ["Title", "Sub", "Small", "", "a < b & \"c\""]


def test_render_docx_heading_marker_without_text_is_empty_paragraph():
    with zipfile.ZipFile(io.BytesIO(render_docx(["# "]))) as z:
        assert b"<w:body><w:p/></w:body>" in z.read("word/document.xml")


# --- render_pdf -------------------------------------------------------------------

def _pdf_text(data: bytes) -> str:
    return "\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(data)).pages)


def test_render_pdf_without_photo_or_template():
    data = render_pdf(["# Resume", "Hello"])
    assert data.startswith(b"%PDF")
    assert len(PdfReader(io.BytesIO(data)).pages) == 1


def test_render_pdf_stamps_photo_on_first_page_only():
    base = render_pdf(["Hello"] + ["line"] * 80)
    stamped = render_pdf(["Hello"] + ["line"] * 80, photo_bytes=_png())
    assert stamped != base
    reader = PdfReader(io.BytesIO(stamped))
    assert len(reader.pages) == len(PdfReader(io.BytesIO(base)).pages) >= 2
    assert "/XObject" in reader.pages[0]["/Resources"]
    assert "/XObject" not in reader.pages[1]["/Resources"]


def test_render_pdf_ignores_undecodable_photo():
    for photo in (b"not an image", b""):
        reader = PdfReader(io.BytesIO(render_pdf(["Hello"], photo_bytes=photo)))
        assert len(reader.pages) == 1
        assert "/XObject" not in reader.pages[0]["/Resources"]


def test_render_pdf_returns_base_when_stamp_yields_nothing(monkeypatch):
    monkeypatch.setattr(doc_render, "_stamp_photo", lambda pdf, photo: None)
    data = render_pdf(["Hello"], photo_bytes=_png())
    assert len(PdfReader(io.BytesIO(data)).pages) == 1


def test_render_pdf_appends_template_marker(monkeypatch):
    captured = {}
    import app.infrastructure.resume_workspace as ws

    def fake_md_to_pdf(md, out):
        captured["md"] = md
        out.write(b"%PDF-fake")

    monkeypatch.setattr(ws, "md_to_pdf", fake_md_to_pdf)
    assert render_pdf(["Body"], template="SIMPLE") == b"%PDF-fake"
    assert captured["md"].splitlines()[0] == "Body"
    assert len(captured["md"].splitlines()) == 2


# --- images -----------------------------------------------------------------------

KEY = "0123456789abcdef0123456789abcdef.png"


class _Q:
    def __init__(self, value):
        self.value = value
        self.calls = []

    async def fetchval(self, sql, *args):
        self.calls.append((sql, args))
        return self.value


class _DB:
    def __init__(self, value):
        self.query = _Q(value)

    def q(self):
        return self.query


async def test_image_bytes_reads_upload_by_key():
    db = _DB(memoryview(b"\x89PNG"))
    assert await image_bytes(db, KEY) == b"\x89PNG"
    assert db.query.calls[0][1] == (KEY,)


async def test_image_bytes_missing_row_is_none():
    assert await image_bytes(_DB(None), KEY) is None


async def test_image_bytes_rejects_unsafe_keys_without_querying():
    bad = ["", "../" + KEY, "a/" + KEY, "a\\" + KEY, "..png",
           "0123456789ABCDEF0123456789ABCDEF.png",  # uppercase hex
           "0123456789abcdef0123456789abcde.png",   # 31 chars
           "0123456789abcdef0123456789abcdef.gif",
           "0123456789abcdef0123456789abcdef",
           "zz23456789abcdef0123456789abcdef.png"]
    for key in bad:
        db = _DB(b"x")
        assert await image_bytes(db, key) is None, key
        assert db.query.calls == [], key


def test_media_type_by_extension():
    assert media_type("a.png") == "image/png"
    assert media_type("a.webp") == "image/webp"
    assert media_type("a.heic") == "image/heic"
    assert media_type("a.jpg") == "image/jpeg"
    assert media_type("noext") == "image/jpeg"
