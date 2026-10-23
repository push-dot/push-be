import io
import re
import zipfile
from uuid import UUID
from xml.etree import ElementTree

import httpx

from app.ingest.pdf_text import extract_pdf_bytes
from app.ingest.web_page import fetch_page_text

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_REPO = re.compile(r"[A-Za-z0-9-]{1,39}/(?!\.+$)[A-Za-z0-9._-]{1,100}")


def docx_text(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        root = ElementTree.fromstring(archive.read("word/document.xml"))
    return "\n".join(
        "".join(t.text or "" for t in p.iter(_W + "t")) for p in root.iter(_W + "p")).strip()


async def read_source(query, source_id: UUID) -> dict | None:
    row = await query.fetchrow(
        "SELECT id, user_id, mime_type, file_name, path, content FROM sources WHERE id = $1", source_id)
    if row is None:
        return None
    mime = row["mime_type"]
    data = bytes(row["content"] or b"")
    if mime == "application/pdf":
        text = extract_pdf_bytes(data)
    elif mime == DOCX:
        text = docx_text(data)
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


async def read_web(url: str) -> str:
    return await fetch_page_text(url)


async def read_github(client: httpx.AsyncClient, repo: str) -> str:
    if not _REPO.fullmatch(repo):
        raise ValueError("repo must be owner/name")
    headers = {"accept": "application/vnd.github.raw+json", "user-agent": "push-ingest"}
    readme = await client.get(f"https://api.github.com/repos/{repo}/readme", headers=headers)
    commits = await client.get(
        f"https://api.github.com/repos/{repo}/commits", params={"per_page": 20},
        headers={**headers, "accept": "application/vnd.github+json"})
    lines = [readme.text if readme.status_code == 200 else ""]
    if commits.status_code == 200:
        lines.extend("- " + (c.get("commit") or {}).get("message", "").split("\n")[0] for c in commits.json())
    return "\n".join(lines).strip()
