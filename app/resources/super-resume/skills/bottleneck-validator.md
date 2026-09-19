---
name: bottleneck-validator
description: >
  Phase 2-X Approach에서 선택한 병목/제약과 문제 예방 카테고리가 실제 이력서/포트폴리오에
  도움이 되는지 검증. 공고 요구사항, 지원자 경험, 기술 스택과의 정합성을 평가하고
  피드백을 제공한다.
allowed-tools:
  - Bash
  - Read
  - Write
---

# Bottleneck Validator — 병목/제약 + 문제 예방 검증

Phase 2-X Approach에서 선택한 접근 방식이 실제로 이력서와 포트폴리오의 공고 적합도를 높이는 데 기여하는지 검증한다.

## 검증 실행 시점

1. **Phase 2-X Approach 직후** — 선택한 병목 레벨/예방 카테고리의 타당성 검증
2. **Phase 2-X 기획서 생성 후** — 각 기획서에 반영된 병목/제약이 실제로 포트폴리오 가치가 있는지 검증
3. **GATE: 결과 제공 전** — 전체 산출물에 대한 최종 검증

---

## 검증 기준

### 1. Relevance — 공고 연관성

선택한 병목/제약과 예방 카테고리가 공고의 기술 스택/도메인과 직접적으로 연결되는가?

| 점수 | 기준 |
|------|------|
| ✅ 적합 | 공고 필수 스택을 직접 활용하거나 주요 업무 키워드와 매칭되는 병목 |
| ⚠️ 부분 | 공고 우대 스택, 간접 연관, 또는 업무 키워드 일부 매칭 |
| ❌ 부적합 | 공고 요구사항(필수 스택 + 주요 업무)과 무관한 병목 |

> **Relevance 판단 시 required_skills(필수 스택) 뿐만 아니라 key_tasks(주요 업무)도 함께 확인하라.**
> 예: `OTA(Expo Updates) 및 릴리즈 파이프라인 운영`이 주요 업무에 있으면 OTA 파이프라인 프로젝트는 ✅ 적합

### 2. Impact — 포트폴리오 임팩트

이 병목을 해결한 경험이 채용 담당자에게 기술적 역량을 입증할 수 있는가?

| 점수 | 기준 |
|------|------|
| ✅ 높음 | 업계에서 흔히 마주치는 문제 + 참신한 해결 방식 |
| ⚠️ 보통 | 일반적인 최적화 기법. 차별화 포인트 부족 |
| ❌ 낮음 | trivial한 문제. 포트폴리오 가치 없음 |

### 3. Feasibility — 실현 가능성

지원자의 현재 경력/스킬로 해당 병목을 해결하는 프로젝트를 구현할 수 있는가?

| 점수 | 기준 |
|------|------|
| ✅ 가능 | 보유 스택으로 1-2주 내 MVP 구현 가능 |
| ⚠️ 도전 | 새로운 스택 학습 필요, 1개월 이상 소요 |
| ❌ 불가능 | 경력/리소스 대비 난이도가 너무 높음 |

### 4. Completeness — 설계 완전성

병목 해결 방법이 성능, 메모리, 에러 처리, 확장성을 모두 고려했는가?

| 점수 | 기준 |
|------|------|
| ✅ 완전 | 메모리, 성능, 에러, 확장 4가지 모두 명시 |
| ⚠️ 불완전 | 1-2가지 누락 |
| ❌ 부족 | 3가지 이상 누락 또는 "TODO" 수준 |

### 5. Resume Gap Closure — 이력서 갭 보완

이 프로젝트가 현재 이력서와 공고 요구사항 사이의 가장 큰 갭을 메우는가?

| 점수 | 기준 |
|------|------|
| ✅ 직접 보완 | 가장 큰 갭(예: 경력연한, 특정 스택)을 직접적으로 보완 |
| ⚠️ 간접 보완 | 갭을 일부 보완하나 직접적이지 않음 |
| ❌ 무관 | 이력서 갭과 무관한 프로젝트 |

---

## 검증 결과 JSON 형식

```json
{
  "approach_validation": {
    "bottleneck_level": {
      "level": "L3",
      "score": "적합|부분|부적합",
      "reason": "선택 사유"
    },
    "prevention_categories": [
      {
        "category": "performance",
        "score": "적합|부분|부적합",
        "reason": "선택 사유"
      }
    ]
  },
  "blueprint_validations": [
    {
      "project_id": "01",
      "project_name": "프로젝트명",
      "relevance": "적합",
      "impact": "높음",
      "feasibility": "가능",
      "completeness": "완전",
      "resume_gap_closure": "직접 보완",
      "overall": "✅ 통과 / ⚠️ 조건부 / ❌ 탈락",
      "feedback": "검증 피드백 텍스트"
    }
  ],
  "summary": {
    "passed": 3,
    "conditional": 1,
    "failed": 0,
    "recommendation": "전체 검증 결과 요약 및 추천"
  }
}
```

---

## 실행 절차

1. `_workspace/01_scenario.json`에서 `approach`, `bottleneck_level`, `prevention_categories` 읽기
2. `_workspace/01_job_analyses.json`에서 공고 요구사항 읽기
3. `_workspace/01_parsed_resume.json`에서 지원자 스킬/경력 읽기
4. 5가지 검증 기준(Relevance, Impact, Feasibility, Completeness, Gap Closure) 각각 평가
5. 평가 결과를 `_workspace/04_validation_report.json`에 저장
6. 검증 결과 요약 표시

## 검증 결과 표시 형식

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🔍 병목/제약 검증 리포트

  [프로젝트명]
  Relevance:    ✅ 적합  — 공고 RN + Expo 스택 직접 활용
  Impact:       ✅ 높음  — 16MB 메모리 제한 + 실시간 스트리밍
  Feasibility:  ⚠️ 도전  — TypedArray 직접 구현 필요
  Completeness: ✅ 완전  — 메모리/성능/에러/확장 전부 명시
  Gap Closure:  ✅ 직접  — 경력 5년 갭을 고난이도 기술로 보완
  ─────────────────────────────────────────
  종합: ✅ 통과
  피드백: "실시간 스트리밍 + 메모리 제한 해결은 RN 포지션에 강력한 시그널"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
