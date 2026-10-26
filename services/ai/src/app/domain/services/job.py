from __future__ import annotations
from app.clock import utcnow
import re
from datetime import datetime
from typing import Optional
from uuid import UUID, uuid4

from app.db import DB, NotFoundError
from app.domain import entities as ent
from app.domain.errors import internal, not_found, revision_conflict, validation_field
from app.domain.reference_text import features_of, link_count, score_band, templates_of
from app.domain.services.ai import AIGate
from app.domain.services.approval import ApprovalService
from app.domain.validators import validate_https_url
from app.infrastructure.store_applications import ApplicationStore
from app.infrastructure.store_evidence import EvidenceStore
from app.infrastructure.store_jobs import GapAnalysisStore, JobStore, ReferenceSampleStore
from app.infrastructure.store_operations import OperationStore
from app.jsonutil import to_jsonable


def _now() -> datetime:
    return utcnow()


_WORD_RE = re.compile(r"[a-z0-9+#가-힣]+")
# Each id costs an evidence read and an approval check inside one transaction.
MAX_ANALYSIS_EVIDENCE = 100
_SAMPLE_PLANS = frozenset({"FREE", "PRO", "ULTRA"})


def significant_words(s: str) -> list[str]:
    return [w for w in _WORD_RE.findall(s) if len(w) >= 3]


def match_evidence(requirement: str, pool: list[ent.CareerEvidence]) -> list[str]:
    ids = []
    req = requirement.lower()
    words = significant_words(req)
    for e in pool:
        hit = any(sk and sk.lower() in req for sk in e.skills)
        if not hit:
            src = e.source_text.lower()
            hit = any(w in src for w in words)
        if hit:
            ids.append(str(e.id))
    return ids


def document_fit_score(requirements: list[str],
                       evidence: ent.CareerEvidence) -> int | None:
    if not requirements:
        return None
    matched = sum(1 for req in requirements if match_evidence(req, [evidence]))
    return matched * 100 // len(requirements)


def _tech_hit(keyword: str, evidence: ent.CareerEvidence) -> bool:
    needle = (keyword or "").casefold()
    if needle == "":
        return False
    for skill in evidence.skills:
        if skill and skill.casefold() == needle:
            return True
    return needle in (evidence.source_text or "").casefold()


def _word_hit(word: str, evidence: ent.CareerEvidence) -> bool:
    needle = word.casefold()
    if needle == "":
        return False
    for skill in evidence.skills:
        if skill and needle in skill.casefold():
            return True
    return needle in (evidence.source_text or "").casefold()


def part_scores(requirements, keywords, evidence_list) -> dict:
    tech = 0
    if keywords:
        hits = sum(
            1 for keyword in keywords
            if any(_tech_hit(keyword, evidence) for evidence in evidence_list))
        tech = hits * 100 // len(keywords)
    matched_ids = set()
    matched_count = 0
    for requirement in requirements:
        ids = match_evidence(requirement, evidence_list)
        if not ids:
            continue
        matched_count += 1
        matched_ids.update(ids)
    if matched_count == 0:
        experience = 0
    else:
        links = sum(
            link_count(evidence.source_text) for evidence in evidence_list
            if str(evidence.id) in matched_ids)
        experience = min(100, links * 100 // matched_count)
    words = []
    seen = set()
    for requirement in requirements:
        for word in significant_words(requirement.lower()):
            if word in seen:
                continue
            seen.add(word)
            words.append(word)
    if not words:
        keyword_score = 0
    else:
        hits = sum(
            1 for word in words
            if any(_word_hit(word, evidence) for evidence in evidence_list))
        keyword_score = hits * 100 // len(words)
    return {
        "techStack": tech,
        "experienceLink": experience,
        "keyword": keyword_score,
    }


def run_gap_analysis(j: ent.JobPosting, app_id: UUID,
                     pool: list[ent.CareerEvidence], method: str) -> ent.GapAnalysis:
    matched, missing = [], []
    for req in j.requirements:
        ids = match_evidence(req, pool)
        if ids:
            matched.append(ent.RequirementMatch(requirement=req, evidence_ids=ids))
        else:
            missing.append(req)
    preferred_missing = [p for p in j.preferred if not match_evidence(p, pool)]
    fit = len(matched) * 100 // len(j.requirements) if j.requirements else None
    return ent.GapAnalysis(
        id=uuid4(), user_id=j.user_id, application_id=app_id, job_id=j.id,
        job_revision=j.revision, evidence_ids=[e.id for e in pool],
        matched=matched, missing=missing, preferred_missing=preferred_missing,
        risks=j.risks or [], fit_score=fit, method=method, created_at=_now(),
        part_scores=part_scores(j.requirements, j.keywords, pool))


def validate_job_input(company: str, title: str, kind: str,
                       source_url: Optional[str], source_text: str) -> None:
    if not 1 <= len(company) <= 200:
        raise validation_field("company", "company must be 1-200 characters")
    if not 1 <= len(title) <= 300:
        raise validation_field("title", "title must be 1-300 characters")
    if not ent.valid_job_source_kind(kind):
        raise validation_field("sourceKind", "must be URL, TEXT or DOM")
    if kind != "TEXT" and not source_url:
        raise validation_field("sourceUrl", "required for URL/DOM sources")
    if source_url:
        try:
            validate_https_url(source_url)
        except ValueError:
            raise validation_field("sourceUrl", "must be an http(s) URL without credentials")
    if not 1 <= len(source_text) <= 200000:
        raise validation_field(
            "sourceText", "collected source text is required (1-200000 characters)")


class JobService:
    def __init__(self, db: DB, approvals: ApprovalService, ai: AIGate):
        self.db = db
        self.jobs = JobStore(db)
        self.analyses = GapAnalysisStore(db)
        self.samples = ReferenceSampleStore(db)
        self.applications = ApplicationStore(db)
        self.evidence = EvidenceStore(db)
        self.approvals = approvals
        self.ops = OperationStore(db)
        self.ai = ai

    async def get(self, user_id: UUID, id_: UUID) -> ent.JobPosting:
        try:
            return await self.jobs.get(user_id, id_)
        except NotFoundError:
            raise not_found()
        except Exception:
            raise internal()

    async def create(self, user_id: UUID, company: str, title: str, source_kind: str,
                     source_url: Optional[str], source_text: str,
                     requirements: list[str], preferred: list[str],
                     deadline: Optional[datetime], language: str) -> ent.JobPosting:
        validate_job_input(company, title, source_kind, source_url, source_text)
        now = _now()
        j = ent.JobPosting(
            id=uuid4(), user_id=user_id, revision=1, company=company, title=title,
            source_kind=source_kind, source_url=source_url, source_text=source_text,
            requirements=requirements or [], preferred=preferred or [],
            keywords=[], risks=[], deadline=deadline, language=language,
            created_at=now, updated_at=now)
        try:
            await self.jobs.create(j)
        except Exception:
            raise internal()
        return j

    async def analyze(self, user_id: UUID, job_id: UUID, application_id: UUID,
                      expected: int, evidence_ids: list[UUID],
                      ai: Optional[ent.AiOptions]) -> ent.Operation:
        evidence_ids = list(dict.fromkeys(evidence_ids))
        if len(evidence_ids) > MAX_ANALYSIS_EVIDENCE:
            raise validation_field(
                "evidenceIds", f"at most {MAX_ANALYSIS_EVIDENCE} evidence items")
        await self.ai.check(user_id, ai)
        op = None

        async def work():
            nonlocal op
            try:
                j = await self.jobs.get(user_id, job_id)
            except NotFoundError:
                raise not_found()
            if j.revision != expected:
                raise revision_conflict(j.revision)
            try:
                app = await self.applications.get(user_id, application_id)
            except NotFoundError:
                raise not_found()
            if app.job_id != job_id:
                raise validation_field(
                    "applicationId", "application does not belong to this job")
            pool = []
            for eid in evidence_ids:
                try:
                    e = await self.evidence.get(user_id, eid)
                except NotFoundError:
                    raise validation_field(
                        "evidenceIds", "evidence " + str(eid) + " not found")
                if e.archived:
                    raise validation_field(
                        "evidenceIds", "evidence " + str(eid) + " is archived")
                await self.approvals.require_evidence_use(user_id, app.id, eid)
                pool.append(e)
            method = ent.METHOD_AI_ASSISTED if ai else ent.METHOD_RULE_BASED
            analysis = run_gap_analysis(j, app.id, pool, method)
            await self.analyses.mark_stale_for_job(user_id, job_id, UUID(int=0))
            await self.analyses.create(analysis)
            await self._save_reference_samples(user_id, j, pool)
            now = _now()
            op = ent.Operation(
                id=uuid4(), user_id=user_id, type=ent.OP_JOB_ANALYSIS,
                application_id=app.id, status=ent.OP_SUCCEEDED,
                result=ent.OperationResult(kind=ent.OP_JOB_ANALYSIS,
                                           value=to_jsonable(analysis)),
                created_at=now, updated_at=now)
            await self.ops.create(op)

        await self.db.run(work)
        return op

    async def _save_reference_samples(self, user_id: UUID, job: ent.JobPosting,
                                      pool: list[ent.CareerEvidence]) -> None:
        q = self.db.q()
        try:
            await q.execute("SAVEPOINT reference_samples")
        except Exception:
            return
        try:
            await self._write_reference_samples(user_id, job, pool)
        except Exception:
            try:
                await q.execute("ROLLBACK TO SAVEPOINT reference_samples")
            except Exception:
                return
            return
        try:
            await q.execute("RELEASE SAVEPOINT reference_samples")
        except Exception:
            return

    async def _write_reference_samples(self, user_id: UUID, job: ent.JobPosting,
                                       pool: list[ent.CareerEvidence]) -> None:
        row = await self.samples.context(user_id)
        if row is None:
            return
        ctx = dict(row)
        if not ctx.get("reference_data"):
            return
        category = ctx.get("job_category")
        tenure = ctx.get("tenure_years")
        if category is None or tenure is None:
            return
        plan = ctx.get("plan")
        if plan is None or str(plan).strip() == "":
            plan = "FREE"
        else:
            plan = str(plan).strip()
        if plan not in _SAMPLE_PLANS:
            return
        for evidence in pool:
            fit = document_fit_score(job.requirements, evidence)
            if fit is None:
                continue
            await self.samples.insert(
                uuid4(), user_id, category, tenure, fit, score_band(fit), plan,
                features_of(evidence.source_text), templates_of(evidence.source_text),
                part_scores(job.requirements, job.keywords, [evidence]))
