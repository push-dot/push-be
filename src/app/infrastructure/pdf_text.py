from __future__ import annotations

import asyncio
import glob
import io
import os
import tempfile


def _extract_opendata(path: str) -> str:
    import opendataloader_pdf
    with tempfile.TemporaryDirectory() as tmp:
        link = os.path.join(tmp, "source.pdf")
        os.symlink(os.path.abspath(path), link)
        out = os.path.join(tmp, "out")
        os.makedirs(out)
        opendataloader_pdf.convert(
            input_path=link, output_dir=out, format="text", quiet=True)
        txts = sorted(glob.glob(os.path.join(out, "*.txt")))
        if not txts:
            raise RuntimeError("pdf extraction produced no text output")
        with open(txts[0], encoding="utf-8", errors="replace") as f:
            return f.read()


def _extract_pypdf(data: bytes) -> str:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def extract_pdf_bytes(data: bytes) -> str:
    return _extract_pypdf(data)


def _extract(path: str) -> str:
    if os.environ.get("CF_WORKER") == "1":
        with open(path, "rb") as f:
            return _extract_pypdf(f.read())
    try:
        return _extract_opendata(path)
    except Exception:
        with open(path, "rb") as f:
            return _extract_pypdf(f.read())


async def extract_pdf_text(path: str) -> str:
    if os.environ.get("CF_WORKER") == "1":
        return _extract(path)
    return await asyncio.to_thread(_extract, path)
