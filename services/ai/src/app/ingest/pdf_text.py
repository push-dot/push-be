from __future__ import annotations

import io
from typing import Final

# Bounds for untrusted uploads: a PDF can declare thousands of pages.
MAX_PAGES: Final = 300
MAX_CHARS: Final = 500_000


def extract_pdf_bytes(data: bytes, max_chars: int = MAX_CHARS, max_pages: int = MAX_PAGES) -> str:
    """Page texts joined by newlines; stops once ``max_chars`` or ``max_pages`` is reached."""
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    parts: list[str] = []
    size = 0
    for page in reader.pages[:max_pages]:
        text = page.extract_text() or ""
        parts.append(text)
        size += len(text) + 1
        if size > max_chars:
            break
    return "\n".join(parts)[:max_chars]
