---
name: blueprint-generator
description: >
  Phase 2-X. 공고 분석 결과를 기반으로 이력서/포트폴리오에 반영 가능한
  문제해결 프로젝트 기획서 4개를 생성한다. 각 기획서는 MVP 범위, 기술 스택,
  아키텍처, 데이터 모델, API, 화면, 작업 분해, 완료 기준, 구현 지시서를 포함한다.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - webfetch
  - request_user_input
---

# Blueprint Generator — 문제해결 프로젝트 기획서 생성

> `work_mode: "experience_blueprint"`일 때 실행한다. 기존 이력서 맞춤 수정 Phase를 건너뛰고,
공고 적합도를 높일 수 있는 프로젝트 기획서를 생성한다.

`references/` 경로는 플러그인 루트 `<plugin-root>/references/`다. 사용자 워크스페이스의 `references/`는 쓰지 않는다.

1. 사용자가 제공한 관련 `references/` 파일이 있으면 열고 원칙을 적용한다.
2. 공고 URL이 있으면 `super-resume:job-analyzer`로 공고의 필수/우대 스택, 서비스 도메인, 업무 맥락, 평가 키워드를 추출한다.
3. 공고 URL이 없으면 사용자가 제공한 목표 직군/회사/도메인 정보를 기준으로 삼는다.
4. `references/experience-blueprints.md`를 참조하여 블루프린트 구조를 결정한다.
5. 아래 원칙에 따라 프로젝트 기획서 4개 생성:
   - 사용자가 4개를 원하지 않으면 그에 맞춰서 생성
   - 모든 프로젝트는 공고의 필수/우대 기술 스택과 서비스 도메인을 최소 1개 이상 직접 사용
   - 가능하면 사용자의 기존 경험(이력서/GitHub)과 공고 요구사항 사이의 갭을 메우는 프로젝트
   - 경험 갭이 없으면 공고 스택을 더 깊이 활용하는 난이도 있는 프로젝트
6. `_workspace/01_scenario.json`의 `bottleneck_level`이 설정되어 있으면 해당 레벨에 맞는 병목/제약을 각 기획서에 포함한다.
7. `references/projects.md`의 수식에 따라 프로젝트당 필수 완료 기준을 설정한다.
8. 각 기획서는 별도 파일로 저장:
   - `_workspace/06_experience_blueprints/01_{project-key}.md`
   - `_workspace/06_experience_blueprints/02_{project-key}.md`
   - `_workspace/06_experience_blueprints/03_{project-key}.md`
   - `_workspace/06_experience_blueprints/04_{project-key}.md`
9. `_workspace/06_experience_blueprints.json`에 모든 기획서의 메타데이터를 저장한다.
10. `references/checklist-formulas.md`를 참조하여 각 기획서의 구현 완료 기준을 구체화한다.
11. 각 기획서는 다음 섹션을 포함한다:
    - 프로젝트 개요 (공고와의 연관성, 필수/우대 스택 매핑)
    - 서비스 맥락에서 발생하는 실제 문제 상황
    - 문제의 사용자/운영/비즈니스 영향
    - 도메인 선택 이유
    - 해결 방향
    - 일부러 만들 병목/제약 (approach가 bottleneck일 때)
    - 일부러 만들 병목/제약 해결 방법
    - 기술적 해결 방법
    - 아키텍처/데이터 플로우 (mermaid)
    - 데이터 모델/엔티티 (mermaid ERD)
    - API 명세 (핵심 엔드포인트)
    - 화면/사용자 플로우 (mermaid)
    - 이벤트/메시지 플로우 (필요시)
    - 측정 지표 (일부러 만든 병목/제약의 해결을 검증할 수 있는 구체적 메트릭)
    - 테스트/부하테스트/관측 방법
    - MVP 범위
    - 기술 스택 (공고 스택과 일치)
    - 구현 작업 분해 (작업 단위)

각 프로젝트 기획서는 실제로 코드 구현이 가능한 수준의 구체성을 가져야 한다.
공고의 기술 스택과 완전히 일치해야 하며, 공고에 없는 기술 스택을 주요 스택으로 사용하지 않는다.

## Job Stack Rule

반드시 공고 URL이 있으면 공고의 **필수/우대 기술 스택**을 기준으로 프로젝트를 생성한다.
- 프로젝트의 주요 기술 스택은 공고의 필수 스택과 완전히 일치하거나 최소 70% 이상 일치해야 한다.
- 공고에 없는 기술을 주요 스택(backend/frontend/infra/language/DB)으로 선택하지 않는다.
- 공고에 없는 기술은 분석/모니터링/테스트 도구나 부수적인 라이브러리 수준에서만 사용할 수 있다.
- 공고 URL이 없으면 목표 직군/회사/도메인에서 예상되는 기술 스택을 사용한다.

## Blueprint Completeness Rule

각 기획서는 반드시 아래 5가지 정보를 누락 없이 포함한다:
1. **서비스 맥락에서 발생하는 실제 문제 상황** — "TODO", "TBD"로 남기지 않는다.
2. **해결 방향** — 문제의 원인, 접근 방식, 왜 이 방향이 적합한지
3. **기술적 해결 방법** — "TODO" 금지, 구체적 기술과 구현 방식을 명시
4. **일부러 만들 병목/제약** — 레벨에 맞게 구체화
5. **완료 기준** — checklist-formulas.md 참조

## Domain Problem Rule

`서비스 맥락에서 발생하는 실제 문제 상황`은 다음과 같이 작성한다:
- **반드시 공고 회사의 실제 서비스/도메인 맥락에서 발생할 수 있는 문제여야 한다.**
- 해당 도메인(핀테크, 커머스, 헬스케어 등)에서 실제로 겪는 문제 유형을 반영한다.
- 문제는 기술적으로 흥미롭고, 공고의 요구 스택으로 해결 가능해야 한다.
- "SNS에서 바이럴" 같은 일반적이고 모든 서비스에 적용 가능한 문제는 지양한다.
- `references/core.md`의 원칙을 반영한 문제여야 한다.