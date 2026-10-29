import asyncio
import io
import json
import re
import zipfile
from typing import Final
from uuid import UUID
from xml.etree import ElementTree

import httpx

from app.ingest.pdf_text import extract_pdf_bytes
from app.ingest.web_page import fetch_page_text

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_REPO = re.compile(r"[A-Za-z0-9-]{1,39}/(?!\.+$)[A-Za-z0-9._-]{1,100}")
# Uncompressed cap: a 20 MB upload can otherwise inflate to gigabytes (zip bomb).
MAX_DOCX_XML: Final = 10 << 20


def docx_text(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        info = archive.getinfo("word/document.xml")
        if info.file_size > MAX_DOCX_XML:
            raise ValueError("docx body is too large")
        # zipfile never inflates past the declared size (a forged one fails the CRC).
        root = ElementTree.fromstring(archive.read(info))
    return "\n".join(
        "".join(t.text or "" for t in p.iter(_W + "t")) for p in root.iter(_W + "p")).strip()


async def read_source(query, source_id: UUID) -> dict | None:
    row = await query.fetchrow(
        "SELECT id, user_id, mime_type, file_name, path, content FROM sources WHERE id = $1", source_id)
    if row is None:
        return None
    mime = row["mime_type"]
    data = bytes(row["content"] or b"")
    # CPU-bound parsing off the event loop (inline on Workers, where to_thread is patched).
    if mime == "application/pdf":
        text = await asyncio.to_thread(extract_pdf_bytes, data)
    elif mime == DOCX:
        text = await asyncio.to_thread(docx_text, data)
    else:
        text = data.decode("utf-8", errors="replace")
    return {"user_id": row["user_id"], "text": text}


async def read_posting(query, posting_id: UUID) -> dict | None:
    row = await query.fetchrow(
        "SELECT id, company_id, title, description, requirements FROM job_postings WHERE id = $1", posting_id)
    if row is None:
        return None
    requirements = row["requirements"] or []
    if isinstance(requirements, str):
        requirements = [requirements]
    text = "\n".join([row["title"] or "", row["description"] or "", *map(str, requirements)])
    return {"company_id": row["company_id"], "text": text}


def _text_list(value) -> list[str]:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, list):
        return []
    return [str(item) for item in value]


def _blocks_text(blocks) -> str:
    parsed = json.loads(blocks) if isinstance(blocks, str) and blocks else blocks
    if not isinstance(parsed, list):
        return ""
    return "\n".join(
        str(block.get("text") or "") for block in parsed if isinstance(block, dict))


async def read_evidence(query, evidence_id: UUID) -> dict | None:
    row = await query.fetchrow(
        "SELECT id, user_id, title, source_text FROM career_evidence "
        "WHERE id = $1 AND archived = false",
        evidence_id)
    if row is None:
        return None
    text = "\n".join([row["title"] or "", row["source_text"] or ""]).strip()
    return {"user_id": row["user_id"], "text": text}


async def read_document(query, document_id: UUID) -> dict | None:
    row = await query.fetchrow(
        "SELECT d.id, d.user_id, d.title, v.blocks FROM documents d "
        "JOIN document_versions v ON v.id = COALESCE(d.finalized_version_id, d.latest_version_id) "
        "WHERE d.id = $1",
        document_id)
    if row is None:
        return None
    text = "\n".join([row["title"] or "", _blocks_text(row["blocks"])]).strip()
    return {"user_id": row["user_id"], "text": text}


async def read_job(query, job_id: UUID) -> dict | None:
    row = await query.fetchrow(
        "SELECT id, user_id, company, title, source_text, requirements FROM jobs "
        "WHERE id = $1 AND archived = false",
        job_id)
    if row is None:
        return None
    text = "\n".join([
        row["company"] or "", row["title"] or "", row["source_text"] or "",
        *_text_list(row["requirements"]),
    ]).strip()
    return {"user_id": row["user_id"], "text": text}


async def read_web(url: str) -> str:
    return await fetch_page_text(url)


async def read_github(client: httpx.AsyncClient, repo: str) -> str:
    if not _REPO.fullmatch(repo):
        raise ValueError("repo must be owner/name")
    headers = {"accept": "application/vnd.github.raw+json", "user-agent": "push-ingest"}
    readme, commits = await asyncio.gather(
        client.get(f"https://api.github.com/repos/{repo}/readme", headers=headers),
        client.get(
            f"https://api.github.com/repos/{repo}/commits", params={"per_page": 20},
            headers={**headers, "accept": "application/vnd.github+json"}))
    lines = [readme.text if readme.status_code == 200 else ""]
    if commits.status_code == 200:
        lines.extend("- " + (c.get("commit") or {}).get("message", "").split("\n")[0] for c in commits.json())
    return "\n".join(lines).strip()
