from __future__ import annotations

import re

_EMAIL = re.compile(r"\S+@\S+")
_PHONE = re.compile(r"(?<!\d)(?:\+?\d[\d\-\s().]{7,}\d)(?!\d)")
_QUOTED = re.compile(r"[\"“「『][^\"”」』]+[\"”」』]")
_COMPANY = re.compile(
    r"(?:주식회사|㈜|\(주\))\s*[0-9A-Za-z가-힣.&+-]+"
    r"|[0-9A-Za-z가-힣.&+-]+\s*(?:주식회사|회사)"
    r"|[0-9A-Za-z가-힣.&+-]+(?:\s+Co\.,)?\s*(?:Corporation|Corp|Inc|Ltd|Company)(?![A-Za-z])"
    r"|[0-9A-Za-z가-힣.&+-]+\s*프로젝트"
    r"|프로젝트\s*[0-9A-Za-z가-힣.&+-]+",
    re.IGNORECASE,
)
_NUMBER = re.compile(r"\d+(?:\.\d+)?")
_METRIC = re.compile(
    r"\d+(?:\.\d+)?\s*(?:%|퍼센트|배|건|명|원|만|억|개|시간|초|ms|회)")
_LATIN = re.compile(r"[A-Za-z][A-Za-z0-9+#.]{3,}")
_TECH = re.compile(r"[A-Za-z]+\d+|\d+[A-Za-z]+|[A-Za-z]+[+#]|[A-Za-z]+\.[A-Za-z]")
_LINK = re.compile(
    r"통해|기반|활용|적용|경험|담당|수행|개선|해결|연결|개발|구현|운영|설계|도입|구축"
    r"|올렸|줄였|맡아|led|built|implemented|using",
    re.IGNORECASE,
)
_SENTENCE_SPLIT = re.compile(r"[\n]+|(?<=[.!?。])\s+")


def _scrub(text: str) -> str:
    masked = _PHONE.sub(" ", _EMAIL.sub(" ", text or ""))
    masked = _QUOTED.sub(" ", masked)
    return _COMPANY.sub(" ", masked)


def features_of(text: str) -> dict:
    scrubbed = _scrub(text)
    count = len(_METRIC.findall(scrubbed))
    depth = "concrete" if (
        _TECH.search(scrubbed) or len(_LATIN.findall(scrubbed)) >= 2
    ) else "shallow"
    return {
        "metric_count": count,
        "has_metric": count > 0,
        "tech_depth": depth,
        "links_experience": _LINK.search(text or "") is not None,
    }


def templates_of(text: str) -> list[str]:
    masked = _PHONE.sub("{연락처}", _EMAIL.sub("{연락처}", text or ""))
    out = []
    for part in _SENTENCE_SPLIT.split(masked):
        line = part.strip()
        if not line:
            continue
        line = _QUOTED.sub("{대상}", line)
        line = _COMPANY.sub("{대상}", line)
        line = _NUMBER.sub("{수치}", line).strip()
        if line:
            out.append(line)
    return out


def score_band(score: int) -> int:
    return score // 10 * 10


def _bucket(sample: dict):
    category = sample.get("job_category")
    tenure = sample.get("tenure_years")
    band = sample.get("score_band")
    if category is None or tenure is None or band is None:
        return None
    return (category, tenure, band)


def eligible(samples: list[dict], minimum: int = 30) -> list[dict]:
    counts = {}
    for sample in samples:
        key = _bucket(sample)
        if key is None:
            continue
        counts[key] = counts.get(key, 0) + 1
    kept = []
    for sample in samples:
        key = _bucket(sample)
        if key is not None and counts[key] >= minimum:
            kept.append(sample)
    return kept


def prompt_lines(samples: list[dict]) -> list[str]:
    groups = {}
    order = []
    for sample in eligible(samples):
        key = _bucket(sample)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(sample)
    lines = []
    for key in order:
        group = groups[key]
        features = [sample.get("features") or {} for sample in group]
        metrics = sum(1 for item in features if item.get("has_metric"))
        concrete = sum(1 for item in features if item.get("tech_depth") == "concrete")
        linked = sum(1 for item in features if item.get("links_experience"))
        category, tenure, band = key
        lines.append(
            f"{category} {tenure}년 {band}점대 {len(group)}건 "
            f"수치 {metrics} 구체 {concrete} 연결 {linked}"
        )
    return lines
