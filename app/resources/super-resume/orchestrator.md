---
name: super-resume
description: >
  Super Resume. 공고 기준으로 이력서/포트폴리오/자기소개서를 맞춤 수정하거나,
  이력서에 반영 가능한 문제해결 프로젝트 기획서를 생성하는 워크플로우 오케스트레이터.
  "super-resume", "Super Resume", "슈퍼 이력서", "resume-creator", "이력서 만들어줘",
  "이력서 수정해줘", "공고에 맞춰줘", "프로젝트 경험 생성해줘",
  "문제해결 경험 만들어줘" 요청 시 반드시 이 스킬을 사용할 것.
  "다시 실행", "수정", "업데이트", "재실행" 등 후속 요청에도 사용.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - webfetch
  - task
  - skill
  - request_user_input
---

# Super Resume — 오케스트레이터

각 Phase를 전용 스킬에 위임하고 GATE를 통해 사용자 확인을 받는다.
워크플로우의 전체 흐름을 제어하며, 실제 작업은 개별 스킬이 수행한다.

```
Phase 0           →  작업 모드 선택 (오케스트레이터 직접 수행)
    │ GATE: work_mode 확정
Phase 0-I         →  skills/input-collector/SKILL.md
    │ GATE: Phase 0-I → Phase 1
Phase 1           →  resume-parser / github-explorer / job-analyzer
    │ GATE: Phase 1 → Phase 2
Phase 2           →  skills/content-strategy/SKILL.md
    │
    ├─ [resume_based] ──────────────────────────→ Phase 3
    │
    └─ [experience_blueprint]
         ├─ Phase 2-X Approach → skills/approach-selector/SKILL.md
         └─ Phase 2-X         → skills/blueprint-generator/SKILL.md
             └─ 구현·완료 기준 검증 → Phase 2 전략 → 선택 산출물 작성
    │
    │ GATE: Phase 2 → Phase 3
Phase 3           →  skills/content-craft/SKILL.md
Phase 3-C         →  skills/score-booster/SKILL.md (조건부)
    │ GATE: Phase 3 → Phase 4
Phase 4           →  quality-review / resume-designer
    │ GATE: Phase 4 → Phase 5
Phase 5           →  pdf-publisher
    │ GATE: Phase 5 → Phase 6
Phase 6           →  skills/result-presenter/SKILL.md
```

---

## Reference Files

Reference files stay in this skill's local `references/` directory and are ignored by git.
After Phase 0 completes and before Phase 0-I begins, load every file in `references/`.
Each loaded file must be applied during the relevant Phase as specified below.

```bash
_REF_DIR="references"
find "$_REF_DIR" -type f 2>/dev/null | sort
```

Mapping:
- `core.md` → input-analyzer (분석), content-strategist (전략), content-crafter (작성)
- `checklist-formulas.md` → content-crafter (작성), quality-reviewer (검증)
- `competency-signals.md` → content-strategist (매칭), content-crafter (문장)
- `experience-blueprints.md` → blueprint-generator (기획)
- `portfolio.md` → content-crafter (포트폴리오 작성)
- `projects.md` → content-crafter (프로젝트 설명), content-strategist (평가)
- `writing-voice.md` → content-crafter (작성), quality-reviewer (검증)

If a reference file cannot be read, report the path and continue.

---
## Phase 0: 작업 모드 선택

이 Phase에서는 작업 모드만 결정한다. 입력 확인, 레퍼런스 조회, 산출물 선택, 추가 입력 수집, 분석은 시작하지 않는다.

가능하면 Codex 질문 UI(`request_user_input`)로 다음 두 선택지만 표시한다. 사용할 수 없는 환경에서만 같은 문구를 일반 텍스트 질문으로 표시한다.

```text
질문: 어떤 방식으로 진행할까요?
선택지:
1. 현재 이력서 기준으로 공고에 맞춰 수정하기
2. 이력서에 넣을 프로젝트/문제해결 경험까지 생성해서 진행하기
```

- **1번** → `work_mode: "resume_based"`
- **2번** → `work_mode: "experience_blueprint"`
- 사용자가 요청에서 방향을 이미 말했어도 선택 질문은 생략하지 않는다.
- 사용자 응답 전에는 기본값을 정하거나 다음 Phase를 시작하지 않는다.
- 응답이 모호하거나 두 선택지를 모두 포함하면 같은 질문을 다시 표시한다.

### GATE: Phase 0 → Phase 0-I (작업 모드 확정)

**대기:** 사용자 응답 필수

**출력:** 확정된 `work_mode`

---
## Phase 0-I: 컨텍스트 확인 + 입력 수집

`skills/input-collector/SKILL.md`에 확정된 `work_mode`를 전달하여 산출물과 입력 자료를 수집한다.
`work_mode`가 없으면 입력 수집을 시작하지 않고 Phase 0으로 돌아간다.
`_workspace/01_scenario.json`이 생성된다.

- 산출물은 비어 있지 않은 `output_targets: ["resume" | "portfolio" | "cover_letter"]` 배열로 저장한다.
- 이전 실행의 `output_target`은 재개 시 배열로 변환한다.
- 자기소개서 선택 시 공고 자료/목표 직군과 실제 경험 근거가 있는지 확인한다.

---

### GATE: Phase 0-I → Phase 1 (분석 시작 확인)

**시점:** 사용자 입력 수집 완료 후, 분석 시작 전

**질문:** "입력을 확인했습니다. 분석을 시작할까요?"

**대기:** 사용자 응답 필수

**분기:**
- **Yes / 네 / 시작** → Phase 1(입력 분석) 진행
- **아니요 / 잠시만요** → "어떤 부분을 수정할까요?" 추가 질문 후 다시 GATE
- **종료 / 취소** → 워크플로우 종료

---

## Phase 1: 입력 분석

### Step 1-1: 이력서 파싱 (이력서가 제공된 경우)

1. `skills/resume-parser/SKILL.md`를 참조하여 이력서 파싱 절차 수행
2. 제공된 이력서 파일/텍스트를 파싱하여 구조화된 데이터로 변환
3. 입력이 PDF이면 `opendataloader-pdf`가 사용 가능한지 먼저 확인하고, 있으면 이를 우선 사용해 텍스트/구조/링크를 추출한다. 없거나 실패하면 `skills/resume-parser/SKILL.md`의 PDF fallback 절차를 따른다.
4. 입력이 PDF이면 텍스트 추출과 별도로 hyperlink annotation/link target을 추출하여 `_workspace/01_extracted_links.json`에 저장
5. 이력서 텍스트 또는 PDF annotation에서 GitHub 프로필 URL과 레포 URL을 추출하여 `personal_info.github`, `personal_info.links`, `projects[].url`에 저장
6. 이력서에 `GitHub`, `Github`, `깃허브`, `Git Hub` 같은 항목은 있으나 텍스트와 PDF annotation 어디에도 실제 URL이 없으면 `missing_inputs.github_url: true`와 `personal_info.github_label_present: true`로 기록
7. 프로필 이미지가 제공된 경우 `personal_info.profile_image`에 경로 저장
8. **말투 감지:** tone이 `"preserve"`(말투유지)인 경우, content-craft에 전달할 말투 분석을 위해 원본 이력서의 말투 특징을 `_workspace/01_tone_profile.json`에 저장
9. 출력: `_workspace/01_parsed_resume.json`, `_workspace/01_original_resume.md`

### Step 1-B: GitHub 기반 경험 수집 (이력서 없음, GitHub 링크만 — 시나리오 F)

> 이력서 없이 GitHub 링크만 제공된 경우, 이 Step으로 건너뛴다.

1. `skills/github-explorer/SKILL.md`를 참조하여 GitHub 경험 수집 절차 수행
2. 출력: `_workspace/01_parsed_resume.json` (GitHub 기반), `_workspace/01_original_resume.md` (비어있거나 GitHub 요약)

### Step 1-2A: GitHub 링크 누락 확인 (GitHub 항목만 있는 경우)

1. `_workspace/01_parsed_resume.json`의 `missing_inputs.github_url` 또는 `personal_info.github_label_present`를 확인
2. 값이 `true`이고 실제 GitHub URL이 없으면 사용자에게 질문

### Step 1-2: GitHub 저장소 탐색 (이력서에 GitHub 링크가 있을 경우)

1. `skills/github-explorer/SKILL.md`를 참조하여 GitHub 저장소 탐색 절차 수행
2. 출력: `_workspace/01_github_findings.json`

### Step 1-3: 공고 자료 분석 (있을 경우)

1. `skills/job-analyzer/SKILL.md`를 참조하여 공고 분석 절차 수행
2. URL, Markdown/PDF, 직접 텍스트를 분석해 요구사항과 `application_questions`를 출력한다.
3. 출력: `_workspace/01_job_analyses.json`, `_workspace/01_job_raw/`

### Step 1-4: 시나리오 분류

Phase 0에서 확정된 작업 모드를 유지하고, 입력에 따라 시나리오를 분류하여 `_workspace/01_scenario.json`에 저장한다.

### 예외 처리: URL에서 읽을 수 없는 섹션이 있는 경우

Phase 1 완료 후 `01_scenario.json`에 `fetch_warnings`가 있으면 사용자에게 알리고 추가 입력을 받는다.

---

### GATE: Phase 1 → Phase 2 (전략 수립 확인)

**시점:** 이력서 파싱 + 공고 분석 + GitHub 탐색 완료 후

**질문 (시나리오별):**
- **work_mode = experience_blueprint:** "이 기준으로 문제해결 프로젝트 기획서를 생성할까요?"
- **시나리오 A/E:** Fit Score를 계산하여 표시한 후 "이 공고에 맞춰서 선택한 산출물을 수정할까요?"
- **시나리오 B:** "종합 피드백을 제공할까요?"
- **시나리오 C:** (디자인 변경 — 전략 생략, 바로 디자인 GATE로)
- **시나리오 F:** "이제 어떻게 진행할까요?"

**대기:** 사용자 응답 필수

**분기:**
- **experience_blueprint + Yes** → Phase 2-X 진행
- **Yes / 수정해줘** → Phase 2(컨텐츠 전략) 진행
- **피드백만** → Phase 2-B(피드백)로 진행
- **종료** → Fit Score 리포트만 출력하고 종료

---

## Phase 2: 컨텐츠 전략

### Phase 2-X Approach: 접근 방식 선택 (experience_blueprint 전용)

> `work_mode: "experience_blueprint"`일 때만 실행한다. Phase 2-X 직전에 접근 방식을 결정한다.

`skills/approach-selector/SKILL.md`를 참조하여 접근 방식 선택을 진행한다.

### Phase 2-X Validation: 접근 방식 검증

> Phase 2-X Approach에서 선택한 병목/제약과 문제 예방 카테고리가 실제 이력서/포트폴리오에 도움이 되는지 검증한다.

`skills/bottleneck-validator/SKILL.md`를 참조하여 5가지 기준(Relevance, Impact, Feasibility, Completeness, Gap Closure)으로 평가한다.

결과는 `_workspace/04_validation_report.json`에 저장한다.

**분기:**
- **✅ 모두 통과** → Phase 2-X 기획서 생성 진행
- **⚠️ 조건부 통과** → 피드백 반영 후 진행 (사용자 확인)
- **❌ 탈락** → Phase 2-X Approach로 돌아가서 접근 방식 재선택

---

**표시 형식:**

```text
질문: 어떤 접근 방식으로 진행할까요?
선택지:
1. 일부러 만들 병목/제약
2. 문제 예방
```

**1번 선택 시 — 병목 레벨:**

```text
질문: 병목/제약 강도를 선택해주세요.
선택지:
1. L1 — 가벼운 제약 (단일 병목, 쉬운 해결)
2. L2 — 중간 제약 (복합 병목, 기술적 도전)
3. L3 — 극한 제약 (다중 극한, 최고 난이도)
```

**2번 선택 시 — 예방 카테고리 (복수 선택 가능):**

```text
질문: 어떤 문제를 예방할까요?
선택지:
1. 성능 (Performance)
2. 보안 (Security)
3. 확장성 (Scalability)
4. 안정성/내결함성 (Reliability)
5. 유지보수성 (Maintainability)
6. 데이터 무결성 (Data Integrity)
```

**모두 선택 가능:** 사용자가 1번과 2번을 모두 선택하면 병목 레벨 + 예방 카테고리를 각각 입력받는다.

값은 `_workspace/01_scenario.json`의 `approach`, `bottleneck_level`, `prevention_categories`에 저장한다.

---

### Phase 2-X: Experience Blueprint — 문제해결 프로젝트 기획서 생성

> `work_mode: "experience_blueprint"`일 때 실행한다.

1. `skills/blueprint-generator/SKILL.md`를 참조하여 공고 기반 문제해결 프로젝트 기획서 4개를 생성한다.
2. Phase 2-X Approach에서 선택한 병목 레벨과 예방 카테고리를 각 기획서에 반영한다.
3. 각 기획서는 별도 md 파일로 `_workspace/06_experience_blueprints/`에 저장한다.
4. 메타데이터는 `_workspace/06_experience_blueprints.json`에 저장한다.

### Phase 2-X Validation: 기획서 검증

> 생성된 각 기획서의 병목/제약과 문제 예방이 포트폴리오 가치가 있는지 개별 검증한다.

`skills/bottleneck-validator/SKILL.md`를 참조하여 각 기획서를 5가지 기준으로 평가한다.

**분기:**
- **✅ 전체 통과** → GATE: 결과 제공으로 진행
- **⚠️ 조건부 통과** → 피드백과 함께 GATE 제시 (사용자가 수용 가능)
- **❌ 1개 이상 탈락** → 탈락한 기획서 재생성 또는 제외 후 진행 (사용자 선택)

---

### GATE: Phase 2-X → 결과 제공

**시점:** 기획서 검증 완료 후

**수행:** 각 기획서의 제목, 설명, 기술 스택, 병목 레벨/예방 카테고리, 검증 결과를 요약하여 표시한다.

**표시 형식:**

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  [회사명] — [포지션]
  [병목 레벨] + [예방 카테고리]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  [번호]. [프로젝트명]
      [레벨] | [한 줄 설명]
      Stack: [기술 스택]
      ─────────────────────────────────────
  ...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**질문:** "문제해결 프로젝트 기획서 N개가 각각 생성되었습니다. 어떤 프로젝트를 구현할까요?"

**대기:** 사용자 응답 필수

**분기:**
- **프로젝트 선택 + 명시 승인** → 선택한 기획서의 MVP 범위, 기술 스택, 아키텍처, 데이터 모델, API, 화면/사용자 플로우, 구현 작업 분해, 완료 기준, 작업 지시서를 기준으로 구현을 진행한다.
- **선택만 하고 승인 모호** → "선택한 프로젝트 구현을 시작해도 될까요?"라고 다시 묻는다.
- **여러 개 선택** → 선택한 프로젝트들을 우선순위 순으로 구현한다.
- **추가 수정 요청** → 해당 기획서를 수정한 후 다시 GATE에 표시한다.
- **기획만 / 지금은 패스** → 기획서 md 파일 4개와 메타데이터만 제공하고 종료한다.

---

### GATE: 프로젝트 구현 완료 → 병목/제약 해결 코드 추가

**시점:** 선택한 프로젝트의 기본 구현이 완료된 후

**질문:** "기획서의 `일부러 만들 병목/제약 해결 방법`대로 해결 코드를 추가할까요?"

**대기:** 사용자 응답 필수

**분기:**
- **승인** → 기획서의 `일부러 만들 병목/제약 해결 방법`, `기술적 해결 방법`, `테스트/부하테스트/관측 방법`, `측정 지표`를 기준으로 해결 코드를 추가한다.
- **수정 요청** → 어떤 병목/제약을 다르게 해결할지 확인한 뒤 반영한다.
- **거절/보류** → 병목/제약은 남겨두고 현재 구현 상태와 남은 TODO를 기록한다.

### 구현 완료 후 선택 산출물 작성

선택한 프로젝트가 기획서의 완료 기준을 충족하고 테스트/측정 근거가 확인된 경우에만:

1. 검증된 프로젝트 결과를 실제 경험 근거로 `_workspace/01_parsed_resume.json`에 반영한다.
2. `output_targets`에 산출물이 있으면 Phase 2 컨텐츠 전략으로 돌아간다.
3. 기획서만 있거나 완료 기준을 충족하지 못했으면 이력서, 포트폴리오, 자기소개서를 작성하지 않는다.

### 공통: Fit Score 표시 (이력서 + 공고 URL이 있을 때)

시나리오 A/E 모두에서, Phase 2 진입 시 반드시 Fit Score를 먼저 계산하여 사용자에게 보여준다.

1. `skills/content-strategy/SKILL.md`를 참조하여 Step 2(적합도 산정)까지 실행
2. GitHub 탐색 결과가 있으면 Fit Score 산정에 반영

### 시나리오 A (맞춤수정)
- Fit Score 표시 후 GATE: "수정할까요?" → Yes → Phase 2 전략 수립

### 시나리오 B (피드백)
- `skills/quality-review/SKILL.md`를 참조하여 종합 피드백 생성
- GATE: "피드백을 반영해서 수정할까요?" → Yes → Phase 3-B

### 시나리오 C (디자인변경)
- 디자인/템플릿만 변경, 전략 생략 → Phase 4-B로 이동

### 시나리오 D (반복수정)
- 이전 결과 기반 Phase 3으로 바로 이동

### 시나리오 E (적합도 확인)
- Fit Score 리포트만 제공하고 종료 가능

### 시나리오 F (깃허브 기반 신규 작성)
- GitHub 경험 기반 Phase 3 컨텐츠 작성

---

### GATE: Phase 2 → Phase 3 (초안 작성 확인)

`cover_letter`가 선택된 경우, 질문 전에 다음을 보여준다:

- 카테고리와 소제목
- 공고 문항/요구사항 근거
- 실제 경험 근거
- 섹션별 글자 수

그리고 "이 카테고리로 작성할까요? 지원동기·입사 후 기여를 포함할까요?"를 묻는다. 사용자의 수정 또는 포함 여부를 `02_strategy.json.cover_letter.sections`에 반영한 뒤에만 초안을 작성한다.

**질문 (시나리오별):**
- **시나리오 A/D:** 전략 수립 완료 후 "전략대로 초안을 작성할까요?"
- **시나리오 B:** "피드백 리포트를 제공할까요?"
- **시나리오 F:** "GitHub 경험을 바탕으로 초안을 작성할까요?"

---

## Phase 3: 컨텐츠 작성

### Phase 3-A: 맞춤수정 컨텐츠 작성

1. `skills/content-craft/SKILL.md`를 참조하여 컨텐츠 작성 절차 수행
2. 전략 + 말투에 따라 선택된 산출물 내용 작성
3. 출력: 선택한 `_workspace/03_draft_resume_v1.md`, `_workspace/03_draft_portfolio_v1.md`, `_workspace/03_draft_cover_letter_v1.md`

### GATE: Phase 3-A 피드백 (중간 버전 검토)

**질문:** "첫 번째 버전(v1) 초안입니다. 마음에 드시나요?"

**분기:**
- **좋아 / 계속** → GATE: Phase 3 → 점수 향상(Phase 3-C)로 이동
- **수정** → v2 생성 후 다시 GATE (최대 3회)

### Phase 3-B: 피드백 반영 수정 (시나리오 B 후속)

1. `skills/content-craft/SKILL.md`를 참조하여 피드백 반영 수정
2. 중간 버전 표시 및 피드백 수렴 (Phase 3-A와 동일)

### GATE: Phase 3 → 점수 향상 (Phase 3-C 진입 결정)

`output_targets`가 `["cover_letter"]`이면 Fit Score 개선 GATE를 생략하고 Phase 4로 이동한다.

**질문:** "Fit Score가 X.X/10입니다. 점수 향상을 진행할까요?"
- 8.0 미만: "약점을 집중 개선할까요?"
- 8.0 이상: "품질 검증을 진행할까요?"

---

### Phase 3-C: 점수 향상 루프 (조건부)

`skills/score-booster/SKILL.md`를 참조하여 Fit Score 8.0 달성을 위한 반복 개선을 수행한다.

---

### GATE: Phase 3-C → Phase 4 (품질 검증 확인)

**질문:** "품질 검증을 진행할까요? (오타/문법/말투/ATS 호환성 검사)"

**분기:**
- **Yes** → Phase 4-A(품질 검증) 진행
- **스킵** → Phase 4-B(디자인 적용)로 이동

---

## Phase 4: 품질 검증 및 디자인

### Phase 4-A: 품질 검증

1. `skills/quality-review/SKILL.md`를 참조하여 품질 검증 절차 수행
2. P0 이슈 자동 수정
3. `_workspace/04_review_report.json.outputs`와 산출물별 `_workspace/04_corrected_{resume|portfolio|cover_letter}.md`를 저장

### GATE: Phase 4-A → Phase 4-B (디자인 적용 확인)

**질문:** "검증 결과를 확인했습니다. 이제 디자인을 적용할까요?"

### Phase 4-B: 디자인 적용

1. `skills/resume-designer/SKILL.md`를 참조하여 디자인 적용 절차 수행
2. 템플릿 선택 옵션 제공
3. 하나의 선택 템플릿을 모든 산출물에 적용한다. 자기소개서는 프로필 이미지 없이 제목·소제목·본문 중심으로 저장한다.

### GATE: Phase 4-B → Phase 5 (PDF 출력 확인)

**질문:** "디자인이 적용되었습니다. PDF로 출력할까요?"

---

## Phase 5: PDF 출력

1. `skills/pdf-publisher/SKILL.md`를 참조하여 PDF 출력 절차 수행
2. 선택한 최종 Markdown을 각각 `_workspace/05_final_{resume|portfolio|cover_letter}.pdf`로 출력

### GATE: Phase 5 → Phase 6 (최종 결과 확인)

**질문:** "PDF 생성이 완료되었습니다. 최종 결과를 확인하시겠어요?"

---

## Phase 6: 최종 결과 제공

`skills/result-presenter/SKILL.md`를 참조하여 최종 결과를 제공한다.

---

## 데이터 전달 프로토콜

| Phase | 입력 | 출력 |
|-------|------|------|
| Phase 0 | 사용자 요청 | `work_mode` |
| Phase 0-I | `work_mode`, 사용자 입력 | `01_scenario.json` (`output_targets`) |
| Phase 1 | Phase 0-I 출력 | `01_parsed_resume.json`, `01_job_analyses.json` (`application_questions`), `01_github_findings.json` |
| Phase 2 | Phase 1 출력 | `02_fit_score.json`, `02_strategy.json` (`cover_letter.sections`) |
| Phase 2-X | Phase 1 출력 | `06_experience_blueprints/`, `06_experience_blueprints.json`, 완료 후 검증된 경험 근거 |
| Phase 3 | Phase 2 출력 | `03_draft_{resume|portfolio|cover_letter}_v{N}.md`, `03_changelog_v{N}.json` (`outputs`) |
| Phase 4 | Phase 3 출력 | `04_review_report.json` (`outputs`), `04_corrected_{target}.md`, `05_final_{target}.md` |
| Phase 5 | Phase 4 출력 | `05_final_{target}.pdf` |

## 에러 핸들링

| 에러 유형 | 처리 |
|----------|------|
| Agent failure | 1회 재시도, 실패 시 해당 결과 없이 진행, 최종 보고서에 누락 명시 |
| Timeout | Phase별 제한 시간: Phase 1 (60s), Phase 2 (60s), Phase 3 (120s), Phase 4 (60s), Phase 5 (120s) |
| URL fetch 실패 | 실패한 URL 건너뛰고 나머지로 진행, 사용자에게 보고 |
| PDF 생성 실패 | 마크다운만 제공, 대체 방법 안내 |
| 데이터 충돌 | 출처 병기, 삭제 금지, 보고서에 상충 표시 |
| 자기소개서 근거 부족 | 초안 없이 실제 경험 자료를 요청 |
| **GATE 무시** | **GATE에서 사용자 응답을 받지 않고 다음 Phase로 진행하지 마라. 사용자 응답이 없으면 다시 질문하라.** |

## GATE 실행 규칙 (필수)

1. **모든 GATE는 반드시 실행하라.** GATE를 건너뛰고 다음 Phase로 진행하지 마라.
2. **사용자 응답을 기다려라.** 사용자가 응답할 때까지 같은 GATE를 유지하라.
3. **GATE 질문은 여러번 할 수 있다.** 사용자가 모호하게 응답하면 다시 명확한 선택지를 제시하라.
4. **사용자가 이전 Phase로 돌아가길 원하면 해당 Phase로 돌아가라.** 순서를 강제하지 마라.
5. **사용자가 갑자기 종료를 원하면 워크플로우를 정리하고 종료하라.** 중간 데이터는 보존하라.

## 중간 버전 관리 규칙

1. 사용자에게 중간 버전을 보여줄 때는 **변경사항 요약**을 함께 제시하라
2. 사용자 피드백은 다음 중 하나여야 한다: "좋아, 계속 진행" 또는 "이 부분을 수정해줘"
3. 최대 반복 횟수: Phase 3에서 최대 3회 (무한 루프 방지)
4. 사용자가 3회 이상 수정을 요청하면 새 실행을 제안한다.
