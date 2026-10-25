from __future__ import annotations

import io

import pytest
from pypdf import PdfWriter
from pypdf.errors import PdfReadError
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from app.ingest.pdf_text import extract_pdf_bytes


def _pdf(*pages: str) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    for text in pages:
        if text:
            c.drawString(72, 760, text)
        c.showPage()
    c.save()
    return buf.getvalue()


def test_extract_pdf_bytes_reads_every_page_in_order():
    text = extract_pdf_bytes(_pdf("Hello resume", "Second page"))
    assert [line for line in text.splitlines() if line] == ["Hello resume", "Second page"]


def test_extract_pdf_bytes_keeps_blank_pages_as_empty_lines():
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    writer.write(buf)
    assert extract_pdf_bytes(buf.getvalue()) == "\n"


def test_extract_pdf_bytes_raises_on_non_pdf():
    with pytest.raises(PdfReadError):
        extract_pdf_bytes(b"not a pdf at all")


def test_extract_pdf_bytes_stops_at_page_and_char_caps():
    data = _pdf(*(f"page {i}" for i in range(10)))
    assert extract_pdf_bytes(data, max_pages=3).split() == ["page", "0", "page", "1", "page", "2"]
    assert len(extract_pdf_bytes(data, max_chars=10)) == 10
