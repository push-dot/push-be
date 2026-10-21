"""Local recruiting seed. Refuses to run unless APP_ENV=development.

Does not belong in a migration. Production databases stay empty of demo rows.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

EMPLOYER_ID = "00000000-0000-4000-8000-000000000011"
SEEKER_ID = "00000000-0000-4000-8000-000000000012"
POSTING_ID = "00000000-0000-4000-8000-000000000021"
POST_ID = "00000000-0000-4000-8000-000000000031"


def assert_development() -> None:
    if os.environ.get("APP_ENV") != "development":
        raise SystemExit("seed_local.py refuses to run unless APP_ENV=development")


async def main() -> None:
    assert_development()
    os.environ.setdefault("DB_DRIVER", "asyncpg")
    os.environ.setdefault("PG_TRANSPORT", "tcp")
    from app.config import load_config
    from app.db import create_pool

    cfg = load_config()
    if not cfg.database_url:
        raise SystemExit("DATABASE_URL is required")
    pool = await create_pool(cfg.database_url)
    try:
        await pool.execute(
            "INSERT INTO users (id, provider, provider_subject, display_name, locale, is_employer) "
            "VALUES ($1, 'seed', 'employer', 'Push Demo', 'ko', true) "
            "ON CONFLICT (provider, provider_subject) DO UPDATE SET display_name = EXCLUDED.display_name, is_employer = true",
            EMPLOYER_ID)
        await pool.execute(
            "INSERT INTO users (id, provider, provider_subject, display_name, locale, is_employer) "
            "VALUES ($1, 'seed', 'seeker', 'Demo Seeker', 'ko', false) "
            "ON CONFLICT (provider, provider_subject) DO UPDATE SET display_name = EXCLUDED.display_name",
            SEEKER_ID)
        await pool.execute(
            "INSERT INTO profiles (user_id, headline, job_category, tenure_years, career_status, open_to_offers, intro, skills) "
            "VALUES ($1, '백엔드', 'dev', 4, 'seeking', true, '로컬 시드 프로필', '[\"Kotlin\"]'::jsonb) "
            "ON CONFLICT (user_id) DO NOTHING",
            SEEKER_ID)
        await pool.execute(
            "INSERT INTO companies (id, name) "
            "VALUES ($1, 'Push Demo') "
            "ON CONFLICT (id) DO NOTHING",
            EMPLOYER_ID)
        await pool.execute(
            "INSERT INTO company_members (company_id, user_id, role) "
            "VALUES ($1, $1, 'ADMIN') "
            "ON CONFLICT (company_id, user_id) DO NOTHING",
            EMPLOYER_ID)
        await pool.execute(
            "INSERT INTO job_postings (id, company_id, company, title, job_category, career_min, career_max, "
            "location, employment_type, description, skills, search_text, search_choseong, search_jamo) "
            "VALUES ($1, $2, 'Push Demo', '백엔드 엔지니어', 'dev', 1, 3, '서울 강남구', 'full_time', "
            "'로컬에서 목록을 확인하는 데모 공고', '[\"Kotlin\"]'::jsonb, '백엔드 엔지니어 Push Demo', '', '') "
            "ON CONFLICT (id) DO NOTHING",
            POSTING_ID, EMPLOYER_ID)
        await pool.execute(
            "INSERT INTO posts (id, user_id, category, title, body, search_text) "
            "VALUES ($1, $2, 'dev', '로컬 시드 글', '개발 카테고리 확인용', '로컬 시드 글') "
            "ON CONFLICT (id) DO NOTHING",
            POST_ID, SEEKER_ID)
        print("seeded employer", EMPLOYER_ID)
        print("seeded seeker", SEEKER_ID)
        print("seeded posting", POSTING_ID)
        print("seeded post", POST_ID)
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
