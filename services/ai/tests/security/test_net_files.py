"""Uploaded PDF and DOCX files: parsing must stay bounded and off the request loop."""

from __future__ import annotations

import asyncio
import io
import socket
import time
import zipfile
import zlib
from xml.etree import ElementTree

import pytest
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, StreamObject

from app.domain.errors import DomainError
from app.ingest import pdf_text
from app.rag.readers import docx_text
from tests.test_cov_svc_evidence import A, _svc


def _slow_pdf(pages: int = 10, stream_bytes: int = 20_000_000) -> bytes:
    """About 50 KB on disk; every page reparses one content stream of ``stream_bytes``."""
    writer = PdfWriter()
    stream = StreamObject()
    stream._data = zlib.compress(b"BT /F1 1 Tf 1 0 0 1 0 0 Tm ET\n" * (stream_bytes // 32), 9)
    stream[NameObject("/Filter")] = NameObject("/FlateDecode")
    contents = writer._add_object(stream)
    font = writer._add_object(
        DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
    )
    resources = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
    for _ in range(pages):
        page = writer.add_blank_page(612, 792)
        page[NameObject("/Contents")] = contents
        page[NameObject("/Resources")] = resources
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


@pytest.fixture(scope="module")
def slow_pdf() -> bytes:
    return _slow_pdf()


async def _ticks_while(work) -> tuple[int, BaseException | None]:
    """How many 50 ms ticks the event loop ran while ``work`` was awaited."""
    ticks = 0
    done = asyncio.Event()

    async def ticker():
        nonlocal ticks
        while not done.is_set():
            await asyncio.sleep(0.05)
            ticks += 1

    task = asyncio.create_task(ticker())
    await asyncio.sleep(0)
    err = None
    try:
        await work
    except BaseException as e:
        err = e
    done.set()
    await task
    return ticks, err


async def test_net_profile_draft_pdf_does_not_block_the_api_loop(monkeypatch, slow_pdf):
    # GET /sources/{id}/profile-draft reads the PDF inside the API process.
    monkeypatch.setattr(pdf_text, "READ_DEADLINE", 1, raising=False)
    svc = _svc()
    src = svc.sources.add(A, slow_pdf, mime="application/pdf", name="cv.pdf")
    started = time.monotonic()
    ticks, err = await _ticks_while(svc._source_text(A, src.id))
    elapsed = time.monotonic() - started
    assert isinstance(err, DomainError) and err.status == 422
    assert elapsed < 3
    assert ticks >= elapsed / 0.05 * 0.5


async def test_net_pdf_reader_is_killed_at_the_deadline(monkeypatch, slow_pdf):
    monkeypatch.setattr(pdf_text, "READ_DEADLINE", 1)
    started = time.monotonic()
    with pytest.raises(ValueError, match="too long"):
        await pdf_text.read_pdf_text(slow_pdf)
    assert time.monotonic() - started < 3


async def test_net_pdf_reader_still_reads_a_normal_pdf():
    reportlab = pytest.importorskip("reportlab.pdfgen.canvas")
    buf = io.BytesIO()
    page = reportlab.Canvas(buf)
    page.drawString(72, 760, "Backend engineer resume")
    page.save()
    assert "Backend engineer resume" in await pdf_text.read_pdf_text(buf.getvalue())


async def test_net_pdf_reader_rejects_a_file_that_is_not_a_pdf():
    with pytest.raises(ValueError, match="cannot be read"):
        await pdf_text.read_pdf_text(b"not a pdf at all")


def _docx(document_xml: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("word/document.xml", document_xml)
    return buf.getvalue()


def test_net_docx_entity_expansion_is_refused_quickly():
    laughs = "".join(f'<!ENTITY l{i} "{f"&l{i - 1};" * 10 if i else "lol"}">' for i in range(10))
    xml = (
        f'<?xml version="1.0"?><!DOCTYPE d [{laughs}]>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body><w:p><w:r><w:t>&l9;</w:t></w:r></w:p></w:body></w:document>"
    )
    started = time.monotonic()
    with pytest.raises(ElementTree.ParseError):
        docx_text(_docx(xml))
    assert time.monotonic() - started < 2


def test_net_docx_external_entities_are_not_fetched(tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("TOP-SECRET")
    xml = (
        f'<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file://{secret}">]>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>"
    )
    try:
        text = docx_text(_docx(xml))
    except Exception:
        return
    assert "TOP-SECRET" not in text


def test_net_document_render_never_fetches_urls_in_the_draft(monkeypatch):
    pytest.importorskip("reportlab")
    from app.infrastructure.doc_render import render_docx, render_pdf

    def no_network(*_args, **_kwargs):
        raise AssertionError("document rendering opened a network connection")

    monkeypatch.setattr(socket, "getaddrinfo", no_network)
    monkeypatch.setattr(socket, "create_connection", no_network)
    monkeypatch.setattr(socket.socket, "connect", no_network)
    draft = [
        "# 이력서",
        "![photo](http://169.254.169.254/latest/meta-data/)",
        '<img src="http://127.0.0.1:6379/x.png">',
        "[link](https://attacker.example/steal)",
    ]
    assert render_pdf(draft).startswith(b"%PDF")
    assert render_docx(draft)
