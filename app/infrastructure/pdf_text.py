from __future__ import annotations

import asyncio
import glob
import os
import tempfile

import opendataloader_pdf


def _extract(path: str) -> str:
    with tempfile.TemporaryDirectory() as out:
        opendataloader_pdf.convert(
            input_path=path, output_dir=out, format="text", quiet=True)
        txts = sorted(glob.glob(os.path.join(out, "*.txt")))
        if not txts:
            raise RuntimeError("pdf extraction produced no text output")
        with open(txts[0], encoding="utf-8", errors="replace") as f:
            return f.read()


async def extract_pdf_text(path: str) -> str:
    return await asyncio.to_thread(_extract, path)
