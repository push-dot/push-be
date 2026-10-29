from __future__ import annotations

import hashlib
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1] / "src" / "app" / "resources" / "super-resume"
_SHA = "225e303689f3986b01dff16323c31d37c867400a"
_PUSH_EDITS = frozenset({"skills/blueprint-generator.md"})
_UPSTREAM_BLUEPRINT = "855855a634ab5d5456d79f10d3693415bd49fb6730717aa3de47db5d9e4bb8ab"
_MATCH = {
    "orchestrator.md": "47e13527bff08ee9cd11f23b266d8b7f2171a02524cf66cab968f298da712d88",
    "references/checklist-formulas.md": "228c6e468bdeb3c276ae076601ce96582c1eb12a524a2d1b018b8199dddcb83e",
    "references/competency-signals.md": "ba27e144d0759a0a78ef1e7922d07145d6a25da9e0b4b41caeb0f4e77ed045c5",
    "references/core.md": "00f3983516e9fdb25f95bd3d9cc46c8a5964e52d3e088a87dfe0d89188e03450",
    "references/experience-blueprints.md": "8a0774f4fa3be7eaecf7a0626af6c1a72c6bdf0491efa499e8ad49b45f327451",
    "references/portfolio.md": "d21970e232d076d79fea9ede73c01ad01c514564df7e8f3373ef05bb37f60430",
    "references/projects.md": "18b1fa21e28e4bf4bb85c56220f82ba3d6d606ace8263aef3d179180eadf1dc1",
    "references/writing-voice.md": "772e8eca9b24f5aad9ec7e982d3c8ef572453382ecd4c50cc16dd7dcd2d944af",
    "skills/approach-selector.md": "f1cb760a66f7f376436c5d53964dd097a0b7c13eec14e5071855625651d87367",
    "skills/bottleneck-validator.md": "c6dade1dd2064bc4045650da72ba0d06258e204cf88228e1efeccc013fc72a23",
    "skills/content-craft.md": "c9ae1c005ff20475c9805e5739444e54f6129ef8e77a29ee30356d813ba2e690",
    "skills/content-strategy.md": "2858e710f5c6bc34e3ea90d04ee5d1e1765dda64f298f0d123eedca2ccb9362d",
    "skills/github-explorer.md": "47475a80e3a60d413824c321935117a9cd128c3dd1ac15d8e813e8d8c3bdec53",
    "skills/input-collector.md": "90448c2074950470ce11710f9d7c30c75e57ecaaa19828ce2badb12de56f8d24",
    "skills/job-analyzer.md": "04690e23cf522475b34a42430e76bd44c4465a9d9c66d5d6692fc19c772a50c6",
    "skills/pdf-publisher.md": "95393101037b4f438316649d8ec53bcc3e9d9055a400d90a44c444d5f6d4ff7d",
    "skills/quality-review.md": "50fd25b1eabf3257b80ef3b1b806fb8cdc0fef66166b88562af0252a9d9b8c77",
    "skills/result-presenter.md": "d7f5495005a003879d249139d2ad3bd616c71d3e915710628b3741a449ce94b3",
    "skills/resume-designer.md": "d3d82fd870b66bdc80c21b667e21c730c9451cfd23187b826e02d87ee0d4fa62",
    "skills/resume-parser.md": "84d791103ecefadf95b210002102bde3d113a9723edd38b311479bd5f4fbfe23",
    "skills/score-booster.md": "5f1f140536901498bae84ca01f95929adc06a944f924903796617276c3fac84b",
}


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_vendored_files_match_upstream_except_push_edits():
    assert (_ROOT / "UPSTREAM").read_text().strip() == _SHA
    present = {path.relative_to(_ROOT).as_posix() for path in _ROOT.rglob("*.md")}
    assert present == set(_MATCH) | _PUSH_EDITS
    for rel, digest in _MATCH.items():
        assert _digest(_ROOT / rel) == digest, rel
    blueprint = _ROOT / "skills/blueprint-generator.md"
    assert _digest(blueprint) != _UPSTREAM_BLUEPRINT
    text = blueprint.read_text()
    assert "채팅 응답 본문에 마크다운 그대로 출력한다" in text
    assert "# file:" in text
    assert "_workspace/06_experience_blueprints/" not in text


def test_writing_voice_has_verb_led_rule():
    text = (_ROOT / "references/writing-voice.md").read_text()
    assert "이력서·포트폴리오 문장은 행동 동사로 시작한다." in text
