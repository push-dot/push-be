"""Apply ``migrations/*.sql`` to Neon (or any Postgres) over TCP.

Workers cannot open port 5432, so run this from a laptop before
``pywrangler deploy``. Neon free projects accept the pooled or direct
host with ``sslmode=require``.

    DATABASE_URL='postgresql://...neon.tech/neondb?sslmode=require' \\
        python scripts/migrate.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("DB_DRIVER", "neon")
os.environ.setdefault("PG_TRANSPORT", "tcp")
os.environ.setdefault("RUN_MIGRATIONS", "1")


async def main() -> None:
    from app.config import load_config
    from app.db import create_pool, run_migrations

    cfg = load_config()
    if not cfg.database_url:
        raise SystemExit("DATABASE_URL is required")
    pool = await create_pool(cfg.database_url)
    try:
        migrations = Path(__file__).resolve().parent.parent / "migrations"
        await run_migrations(pool, str(migrations))
        print("migrations applied")
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
