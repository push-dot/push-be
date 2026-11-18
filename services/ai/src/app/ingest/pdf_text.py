from __future__ import annotations

import asyncio
import io
import sys
from typing import Final

# Bounds for untrusted uploads: a PDF can declare thousands of pages.
MAX_PAGES: Final = 300
MAX_CHARS: Final = 500_000
# A 50 KB PDF can hold content streams that take pypdf minutes to parse, so a read runs in
# a child process that is killed at the deadline.
READ_DEADLINE: Final = 30
_MEMORY_LIMIT: Final = 1 << 30
# Each child may use 1 GiB, so reads beyond this wait their turn instead of starting.
_READ_SLOTS: Final = asyncio.Semaphore(2)


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


async def read_pdf_text(data: bytes) -> str:
    """``extract_pdf_bytes`` in a child process. ValueError when the PDF cannot be read in time."""
    async with _READ_SLOTS:
        # -P: the script's directory (app/ingest) must not shadow stdlib or pypdf modules.
        child = await asyncio.create_subprocess_exec(
            sys.executable, "-P", __file__, str(int(READ_DEADLINE) + 1),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL)
        try:
            out, _ = await asyncio.wait_for(child.communicate(data), READ_DEADLINE)
        except TimeoutError:
            raise ValueError("the PDF took too long to read") from None
        finally:
            if child.returncode is None:
                child.kill()
                await asyncio.shield(child.wait())
    if child.returncode != 0:
        raise ValueError("the PDF cannot be read")
    return out.decode()


def _child_main(cpu_seconds: int) -> None:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
    if sys.platform == "linux":  # macOS does not enforce RLIMIT_AS
        resource.setrlimit(resource.RLIMIT_AS, (_MEMORY_LIMIT, _MEMORY_LIMIT))
    sys.stdout.buffer.write(extract_pdf_bytes(sys.stdin.buffer.read()).encode(errors="replace"))


if __name__ == "__main__":
    _child_main(int(sys.argv[1]))
