"""Copy files from VPS disk into Postgres before core serves them.

    docker compose exec ai-worker python scripts/migrate_blobs_to_db.py

Run once on the VPS, after migration 0024 and before the gateway sends
source and image routes to core. Sources whose path is not db://... get
their bytes in sources.content and path db://sources/<id>. Files under
STORAGE_DIR/images go to upload_images; the owner is the profile that uses
the key as its avatar, if any. Safe to run twice.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from app.infrastructure.images import _safe_key, media_type


async def migrate(conn, storage_dir: str) -> dict:
    moved = missing = images = 0
    for row in await conn.fetch("SELECT id, path FROM sources WHERE path NOT LIKE 'db://%'"):
        path = Path(row["path"])
        if not path.is_file():
            missing += 1
            continue
        await conn.execute(
            "UPDATE sources SET content = $2, path = $3 WHERE id = $1",
            row["id"], path.read_bytes(), f"db://sources/{row['id']}")
        moved += 1
    folder = Path(storage_dir) / "images"
    for file in sorted(folder.iterdir()) if folder.is_dir() else []:
        if not _safe_key(file.name):
            continue
        tag = await conn.execute(
            "INSERT INTO upload_images (key, user_id, mime_type, content) "
            "VALUES ($1, (SELECT user_id FROM profiles WHERE avatar_key = $1 LIMIT 1), $2, $3) "
            "ON CONFLICT (key) DO NOTHING",
            file.name, media_type(file.name), file.read_bytes())
        images += int(tag.split()[-1])
    return {"sources": moved, "missingFiles": missing, "images": images}


async def main() -> None:
    import asyncpg
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        print(await migrate(conn, os.environ.get("STORAGE_DIR", "/data/sources")))
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
