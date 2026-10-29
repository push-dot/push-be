"""Employer harness persistence. Every read that touches applicants is scoped to the company."""

from __future__ import annotations

import json
from uuid import UUID, uuid4

from app.infrastructure.store_common import Store


def _uuid(value) -> UUID | None:
    if value in (None, ""):
        return None
    try:
        return UUID(str(value))
    except ValueError:
        return None


def posting_text(row) -> str:
    if not row:
        return ""
    data = dict(row)

    def items(key):
        raw = data.get(key)
        raw = json.loads(raw) if isinstance(raw, str) else raw
        return [str(x) for x in raw or []]

    lines = [
        f"제목: {data.get('title') or ''}",
        f"직무: {data.get('job_category') or ''}",
        f"경력: {data.get('career_min')}-{data.get('career_max') or ''}년",
        f"하는 일:\n{data.get('description') or ''}",
    ]
    lines += ["자격 요건:", *[f"- {x}" for x in items("requirements")]]
    lines += ["우대 사항:", *[f"- {x}" for x in items("preferred")]]
    return "\n".join(lines)


class EmployerStore(Store):
    async def company(self, company_id):
        return await self.q().fetchrow(
            "SELECT id, name, plan, profile, profile_refreshed_at FROM companies WHERE id = $1",
            _uuid(company_id),
        )

    async def save_profile(self, company_id, profile: dict, refreshed_at) -> None:
        await self.q().execute(
            "UPDATE companies SET profile = $2::jsonb, profile_refreshed_at = $3 WHERE id = $1",
            _uuid(company_id),
            json.dumps(profile, ensure_ascii=False),
            refreshed_at,
        )

    async def posting(self, posting_id):
        """Any posting is readable as a reference; it is public on Push."""
        return await self.q().fetchrow(
            "SELECT title, job_category, career_min, career_max, description, requirements, "
            "preferred, company_id FROM job_postings WHERE id = $1",
            _uuid(posting_id),
        )

    async def application(self, application_id, company_id):
        return await self.q().fetchrow(
            "SELECT a.id, a.user_id, p.id AS posting_id, p.title, p.job_category, p.career_min, "
            "p.career_max, p.description, p.requirements, p.preferred "
            "FROM applications a JOIN jobs j ON j.id = a.job_id "
            "JOIN job_postings p ON p.id = j.source_posting_id "
            "WHERE a.id = $1 AND p.company_id = $2",
            _uuid(application_id),
            _uuid(company_id),
        )

    async def snapshots(self, application_id, company_id) -> list[dict]:
        rows = await self.q().fetch(
            "SELECT s.title, s.content, s.created_at FROM application_snapshots s "
            "JOIN applications a ON a.id = s.application_id "
            "JOIN jobs j ON j.id = a.job_id JOIN job_postings p ON p.id = j.source_posting_id "
            "WHERE s.application_id = $1 AND p.company_id = $2 ORDER BY s.created_at, s.id",
            _uuid(application_id),
            _uuid(company_id),
        )
        return [dict(r) for r in rows]

    async def applicant_context(self, user_id):
        return await self.q().fetchrow(
            "SELECT p.job_category, p.tenure_years FROM profiles p WHERE p.user_id = $1",
            _uuid(user_id),
        )

    async def save_review(
        self,
        company_id,
        conversation_id,
        application_id,
        report: dict,
        attachment_name: str | None = None,
    ) -> str:
        review_id = uuid4()
        await self.q().execute(
            "INSERT INTO employer_reviews (id, company_id, conversation_id, application_id, "
            "attachment_name, report) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
            review_id,
            _uuid(company_id),
            _uuid(conversation_id),
            _uuid(application_id),
            attachment_name,
            json.dumps(report, ensure_ascii=False),
        )
        return str(review_id)

    async def latest_review(self, company_id, application_id):
        return await self.q().fetchrow(
            "SELECT id, report FROM employer_reviews WHERE company_id = $1 AND application_id = $2 "
            "ORDER BY created_at DESC, id DESC LIMIT 1",
            _uuid(company_id),
            _uuid(application_id),
        )

    async def save_kit(
        self, company_id, conversation_id, application_id, review_id, kit: dict
    ) -> str:
        kit_id = uuid4()
        await self.q().execute(
            "INSERT INTO employer_interview_kits (id, company_id, conversation_id, review_id, "
            "application_id, kit) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
            kit_id,
            _uuid(company_id),
            _uuid(conversation_id),
            _uuid(review_id),
            _uuid(application_id),
            json.dumps(kit, ensure_ascii=False),
        )
        return str(kit_id)
