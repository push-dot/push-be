---
name: approach-selector
description: >
  Phase 2-X Approach. 분석 시작 전 사용자에게 접근 방식(일부러 만들 병목/제약 vs 문제 예방)을
  선택하게 하고, 병목 레벨(3단계) 또는 예방 카테고리를 입력받는다.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - request_user_input
---

# Approach Selector — 접근 방식 선택

Phase 0에서 본격적인 입력 수집 전, 사용자의 접근 방향을 먼저 결정한다.
선택 질문은 가능한 경우 Codex의 실제 질문 UI(`request_user_input`)로 표시한다.
`request_user_input`을 사용할 수 없는 환경에서만 동일한 문구를 일반 텍스트 질문으로 대체한다.

## 접근 방식 선택

Codex 질문 UI를 사용할 수 있으면 다음 구조로 질문한다:

```text
질문: 어떤 접근 방식으로 진행할까요?
선택지:
1. 일부러 만들 병목/제약
2. 문제 예방
```

선택값은 `_workspace/01_scenario.json`의 `approach`에 저장한다.

- `1. 일부러 만들 병목/제약` → `approach: "bottleneck"`
- `2. 문제 예방` → `approach: "prevention"`

---

## 선택지 1: 일부러 만들 병목/제약 — 3단계 레벨

`approach: "bottleneck"`일 때, 병목/제약의 강도를 3단계 중 선택하게 한다.

```text
질문: 병목/제약 강도를 선택해주세요.
선택지:
1. L1 — 가벼운 제약 (단일 병목, 쉬운 해결)
2. L2 — 중간 제약 (복합 병목, 기술적 도전)
3. L3 — 극한 제약 (다중 극한 제약, 최고 난이도)
```

선택값은 `_workspace/01_scenario.json`의 `bottleneck_level`에 저장한다.

- **L1 — 가벼운 제약:** 병목 지점 1~2개, 일반적인 해결 방식으로 충분. (예: 단일 코어 제한, 캐시 미사용, 레이턴시 500ms 목표)
- **L2 — 중간 제약:** 병목 지점 3~5개, 복합적인 기술적 의사결정 필요. (예: 초당 10 TPS 제한, 최적화 금지 패턴 2~3개, 메모리 128MB 제한, 외부 라이브러리 최소화)
- **L3 — 극한 제약:** 병목 지점 5개 이상, 비정형적 해결 방식 요구. (예: 네트워크 차단, 파일 I/O만 허용, DB 사용 금지, 메모리 16MB, 응답 시간 50ms)

이 값은 이후 Phase 2-X(Experience Blueprint)의 "일부러 만들 병목/제약" 필드와
GATE(프로젝트 구현 완료 → 병목/제약 해결 코드 추가)에서 참조된다.

---

## 선택지 2: 문제 예방 — 카테고리 선택

`approach: "prevention"`일 때, 예방할 문제의 카테고리를 선택하게 한다. (복수 선택 가능)

```text
질문: 어떤 문제를 예방할까요? (복수 선택 가능)
선택지:
1. 성능 (Performance) — 처리량, 레이턴시, 리소스 사용량
2. 보안 (Security) — 인증, 데이터 보호, 취약점
3. 확장성 (Scalability) — 수평 확장, 병목 분산
4. 안정성/내결함성 (Reliability) — 장애 복구, 중복 구성
5. 유지보수성 (Maintainability) — 코드 품질, 문서화, 테스트
6. 데이터 무결성 (Data Integrity) — 정합성, 손실 방지, 백업
```

선택값은 `_workspace/01_scenario.json`의 `prevention_categories`에 배열로 저장한다.
(예: `["performance", "security", "reliability"]`)

이 카테고리는 Phase 2(컨텐츠 전략)의 문제 예방 전략 수립과
Phase 3(컨텐츠 작성)의 검토 기준으로 활용된다.