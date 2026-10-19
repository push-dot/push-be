"""Apply ``migrations/*.sql`` to Neon (or any Postgres).

Workers cannot open port 5432, so run this from a laptop before
``pywrangler deploy``. The default transport is TCP + TLS. When outbound
5432 is blocked, set ``PG_TRANSPORT=websocket`` to use Neon's
``wss://<host>/v2`` endpoint instead (same wire protocol). The manual
GitHub Action defaults to websocket and can be switched to tcp.

    DATABASE_URL='postgresql://...neon.tech/neondb?sslmode=require' \\
        python services/ai/scripts/migrate.py

    PG_TRANSPORT=websocket \\
    DATABASE_URL='postgresql://...neon.tech/neondb?sslmode=require' \\
        python services/ai/scripts/migrate.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

os.environ.setdefault("DB_DRIVER", "neon")
os.environ.setdefault("PG_TRANSPORT", "tcp")
os.environ.setdefault("RUN_MIGRATIONS", "1")


async def main() -> None:
    from app.config import load_config
    from app.db import create_pool, migrations_dir, run_migrations

    cfg = load_config()
    if not cfg.database_url:
        raise SystemExit("DATABASE_URL is required")
    pool = await create_pool(cfg.database_url)
    try:
        migrations = migrations_dir()
        await run_migrations(pool, str(migrations))
        print("migrations applied")
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
