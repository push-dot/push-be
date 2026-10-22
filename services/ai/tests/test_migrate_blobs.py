import os
from pathlib import Path
from uuid import uuid4

import pytest

from scripts.migrate_blobs_to_db import migrate


@pytest.mark.asyncio
async def test_disk_sources_and_images_move_into_postgres(tmp_path: Path):
    url = os.environ.get("RAG_PG_URL")
    if not url:
        pytest.skip("RAG_PG_URL not set")
    asyncpg = pytest.importorskip("asyncpg")
    conn = await asyncpg.connect(url)
    user, on_disk, gone = uuid4(), uuid4(), uuid4()
    key = "abcdefabcdefabcdefabcdefabcdefab.png"
    file = tmp_path / "cv.txt"
    file.write_bytes(b"resume text")
    (tmp_path / "images").mkdir()
    (tmp_path / "images" / key).write_bytes(b"\x89PNG")
    (tmp_path / "images" / "not-a-key.png").write_bytes(b"x")
    try:
        await conn.execute(
            "INSERT INTO users (id, provider, provider_subject, display_name) VALUES ($1, 'email', $2, 'a')",
            user, str(user))
        for sid, path in ((on_disk, str(file)), (gone, str(tmp_path / "missing.txt"))):
            await conn.execute(
                "INSERT INTO sources (id, user_id, file_name, mime_type, size, sha256, path) "
                "VALUES ($1, $2, 'cv.txt', 'text/plain', 11, 'x', $3)", sid, user, path)
        first = await migrate(conn, str(tmp_path))
        again = await migrate(conn, str(tmp_path))
        row = await conn.fetchrow("SELECT path, content FROM sources WHERE id = $1", on_disk)
        assert first == {"sources": 1, "missingFiles": 1, "images": 1}
        assert again == {"sources": 0, "missingFiles": 1, "images": 0}
        assert row["path"] == f"db://sources/{on_disk}"
        assert bytes(row["content"]) == b"resume text"
        assert bytes(await conn.fetchval("SELECT content FROM upload_images WHERE key = $1", key)) == b"\x89PNG"
    finally:
        await conn.execute("DELETE FROM upload_images WHERE key = $1", key)
        await conn.execute("DELETE FROM users WHERE id = $1", user)
        await conn.close()
