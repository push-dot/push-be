# 기업 하네스 설계 (super-recruit)

작성: Opus (설계·구현·검수 담당) · 2026-10-30
근거: workspace docs `feature-spec.md` 17장·18장, `PRD.md` 7.15·7.16, 웹 Claude Design "기업 AI" 6개 화면, push-be `origin/develop` 4a2bb66
함께 읽을 것: `2026-10-30-python-vps-langgraph-super-resume.md` (Track L·H 결과를 이 설계가 그대로 쓴다)

## 1. 왜 만드나

구직자 에이전트 뒤에는 super-resume이 있다. Phase 0–6, GATE, 스킬 14개, 기준 문서 7개가 있어서 "아무렇게나 쓰지 않는" 흐름이 구조로 강제된다. 기업 에이전트에는 그런 뼈대가 없다.

지금 기업 하네스(`harness/employer/`)의 상태:
- 시스템 프롬프트 6줄과 공고 JSON 형식 지시뿐이다. 형식 지시는 반말이라 문체도 섞여 있다.
- 도구 17개를 모델이 알아서 고른다. 공고 만들기, 서류 검토, 면접 준비에 정해진 순서가 없다.
- docs의 핵심 기능인 **참고 데이터로 과장을 가려내는 기능**이 없다. 이 기능은 예전 채팅 경로(`graphs/chat.py:338`)에만 있다.
- 면접 준비는 프롬프트 한 줄("PRO 이상만")에 기대고 있다.
- 외부 PDF를 대화 범위로 보관하고 지우는 규칙을 코드에서 확인하지 못했다.

기업 요금제는 같은 등급 개인 요금제보다 한 단계 위 모델을 쓴다(PRD 7.13). 개인 AI가 다듬은 서류를 기업 AI가 걸러내야 한다는 뜻이다. 그러려면 기업 쪽에도 super-resume만큼 단단한 흐름과 기준이 필요하다.

## 2. 목표 · 하지 않을 것 · 실패로 보는 것

**목표**
1. 채용 담당자의 네 가지 일을 각각 정해진 흐름으로 돌린다: 공고 만들기, 지원자 서류 검토, 면접 준비, 인재 찾기와 제안.
2. 판단은 근거와 함께 보여준다. 근거는 회사 검색 결과, 지원자가 낸 서류 원문, 참고 데이터 통계 가운데 하나다.
3. 웹 디자인의 6개 화면과 같은 카드로 보여준다(회사 정보 검색, 번호 선택지, 공고 초안 v1, 확인 필요 · 근거 충분, 면접 질문 + 확인할 점, 외부 PDF).
4. 요금제 경계를 서버에서 지킨다: 면접 준비는 Pro부터, 외부 PDF는 Ultra만.

**하지 않을 것 (이번 범위 밖)**
- 합격 · 불합격 판정, 지원자 순위 매기기, 점수로 줄 세우기
- AI 대화 면접, 인성 면접(docs에서 추후)
- 불합격 통보 문구 작성, 지원자에게 직접 보내는 메시지(단계 변경 알림은 기존 기능)
- 여러 지원자를 한 표로 비교하는 기능(편향 위험이 커서 다음 단계에서 따로 설계)

**실패로 보는 것 (기술적으로 돌아가도 실패)**
- AI가 "이 지원자를 추천해요"처럼 합격 · 불합격을 정하는 말을 한다.
- 다른 사용자의 서류 문장(참고 데이터 원문 · 템플릿)이 답변에 나온다.
- 공고 초안에 나이, 성별, 출신, 혼인, 신체 조건 같은 차별 표현이 들어간다.
- 면접 질문에 법으로 물으면 안 되는 질문이 들어간다.
- 참고 공고의 문장을 그대로 옮긴다.
- 다른 회사 데이터를 본다.

## 3. 전체 구조

```
EmployerHarness (LangGraph, thread = <conv>, AsyncPostgresSaver)
 START → route
 route ─(flow 진행 중)→ 해당 flow 하위 그래프
 route ─(그 외)→ agent ⇄ tools          # 자유 대화 · 일반 도구
 agent의 시작 도구 → Command(goto=flow)
   start_posting      → posting_flow
   review_applicant   → review_flow
   prepare_interview  → interview_flow   (Pro 이상)
   find_talent        → sourcing_flow
 flow 끝 · "그만하기" → agent (요약 메시지를 남기고 같은 턴에 돌아온다)
```

- 개인 하네스(personal + resume 하위 그래프, plan Track H)와 같은 구조를 쓴다. checkpointer, interrupt, 승인 카드, 토큰 스트리밍이 같은 코드다.
- 웹에서 들어오는 시작점도 같은 도구로 들어간다. "이 공고 참고해서 만들기"는 `intent=posting` + 참고 공고 첨부로 오고, `posting_flow`를 바로 시작한다. 지원자 화면의 "서류 검토"는 `intent=review` + `application_id`로 온다.
- 모델 호출은 Track L의 `chat_model_for(levers)`(LangChain `ChatOpenAI`, 기업 레버), 도구는 `StructuredTool`, 구조화 출력은 `with_structured_output`을 쓴다.
- RAG가 필요한 곳(회사가 올린 자료 검색)은 LlamaIndex 검색 도구를 쓴다. 범위는 `company_id`로만 걸린다.

## 4. 흐름별 설계

각 단계는 노드 하나, 확인 지점(GATE)은 `interrupt` + 승인 카드(`kind=EMPLOYER_GATE`, 제목은 아래 질문 그대로, "그만하기" 선택지 항상 포함)다.

### 4.1 공고 만들기 (`posting_flow`, 모든 요금제)

| 단계 | 노드 | 하는 일 | 출력 |
|---|---|---|---|
| 0 | `pf_start` | 시작점 판단: 참고 공고 첨부 / 새 공고 / 기존 공고 고치기 | `start_kind` |
| 1 | `pf_research` | 회사 조사. 웹 검색(`:online`)으로 홈페이지 · 뉴스 · Push 기존 공고를 읽고, 출처 URL과 함께 회사 프로필을 만든다. 같은 회사 프로필은 30일 캐시 | 회사 정보 검색 카드(읽은 출처 수, 핵심 사실 3개, 출처 링크) |
| 1 | `pf_reference` | 참고 공고가 있으면 요건 · 연차 · 구조만 뽑는다. 문장은 가져오지 않는다 | 참고 공고 요약(필수 N · 우대 N · 연차) |
| 2 | `pf_role` | 어떤 사람이 필요한지 정한다. 회사 조사와 참고 공고의 차이를 짚고 선택지 3개 + "직접 말하기"를 낸다 | **GATE "이번에 가장 필요한 사람은 누구예요?"** |
| 2 | `pf_role_detail` | 연차 범위, 꼭 필요한 기술 · 있으면 좋은 기술, 근무 형태를 묻는다. 이미 답한 건 다시 묻지 않는다 | 역할 정의 `RoleSpec` |
| 3 | `pf_draft` | `PostingDraft`를 구조화 출력으로 쓴다 | 공고 초안 v1 카드 |
| 4 | `pf_review` | 공고 검수(아래 4.1.1). 고칠 게 있으면 고친 v2를 만든다 | 검수 결과 줄 + 초안 vN |
| 4 | `pf_confirm` | **GATE "이 초안으로 진행할까요?"** 선택지: 공고 편집에서 열기 · 다시 쓰기 · 직접 고치기 · 그만하기. 연봉 범위가 없으면 "연봉 범위를 넣을까요?"를 함께 묻는다 | 다음 행동 |
| 5 | `pf_save` | 초안 저장(`draft_posting`, 안전한 쓰기). 게시는 담당자가 공고 편집에서 하거나 `publish_posting`(위험한 쓰기, 승인 필요) | posting id |

**4.1.1 공고 검수 규칙 (`posting-reviewer`)**
- 차별 표현 검사: 결정적 목록(코드) + 모델 판단을 둘 다 쓴다. 목록에 걸리면 무조건 고친다.
- 요건 정합성: 연차 범위와 자격 요건이 맞는지(예: "1–3년"인데 "리드 경험 필수").
- 검증 가능성: "열정", "책임감" 같은 확인할 수 없는 요건은 하는 일이나 우대 사항으로 옮긴다.
- 개수: 필수 요건 3–5개, 우대 사항 2–4개.
- 참고 공고와의 유사도: 문장 단위로 비교해서 너무 비슷하면 다시 쓴다.
- 근무 조건 빠짐: 근무지 · 고용 형태 · 근무 방식은 필수. 연봉 범위는 권장(없으면 묻는다).

### 4.2 지원자 서류 검토 (`review_flow`, 모든 요금제 · 외부 PDF는 Ultra)

| 단계 | 노드 | 하는 일 | 출력 |
|---|---|---|---|
| 0 | `rv_target` | 대상 확인: Push 지원자(`application_id`) 또는 외부 PDF(Ultra) | 대상 |
| 1 | `rv_read` | 지원 당시 스냅샷(`application_snapshots`)을 읽는다. 외부 PDF는 이 대화 첨부에서만 읽는다 | "제출 서류 읽기 · 지원할 때 제출한 그대로예요" 카드 |
| 2 | `rv_match` | 공고 요건마다 서류에 근거가 있는지 본다: 충족 · 일부 · 없음 + 근거 문장(지원자 서류에서만 인용) | 요건 매칭 |
| 3 | `rv_baseline` | 참고 데이터 기준선을 만든다. 직무 × 연차 × 점수대 구간에서 표본 30개 이상일 때만 쓴다. 범위는 기업 레버를 따른다(Basic ±1년 · 한 단계 위까지, Pro ±2년 · 최상위까지, Ultra 전 연차 · 전 구간) | 기준선 통계(수치 성과 비율, 기술 설명 깊이, 경험-역량 연결 비율) |
| 4 | `rv_verify` | 과장 판별(아래 4.2.1). 판단마다 수준을 붙인다: 확인 필요 · 근거 충분 · 판단 보류 | `ReviewReport.flags` |
| 5 | `rv_report` | 카드로 보여준다. 마지막 줄은 늘 "합격·불합격은 담당자가 정해요. AI는 확인할 부분만 짚어요." | **GATE "다음으로 무엇을 할까요?"** 선택지: 면접 질문 만들기(Pro 미만이면 잠금 안내) · 지원자 서류 열기 · 그만하기 |

**4.2.1 과장 판별 규칙 (`claim-verifier`)**
- 수치만 있고 방법이 없다: "p99 420ms → 180ms"인데 무엇을 직접 바꿨는지 설명이 없다.
- 주어가 흐리다: "팀에서 달성했다"와 "내가 했다"가 섞여 있다.
- 기간 · 규모가 서로 안 맞는다: 재직 기간보다 프로젝트 기간이 길다, 같은 기간에 겹치는 역할이 많다.
- 기술 나열과 사용 맥락이 따로 논다: 기술 스택에는 있는데 경력 본문에 쓴 흔적이 없다.
- 문장 구조는 고급인데 구체 내용이 비었다: 처리량, 장애 사례 같은 빈칸이 채워지지 않았다.
- 연차 대비 깊이: 기준선이 있을 때만 "같은 연차 서류보다 설명이 얕아요"처럼 비교한다. 기준선이 없으면 이 판단은 하지 않는다(화면에 별도 표시도 하지 않는다, docs 18.1).
- 인용은 지원자 서류에서만 한다. 참고 데이터는 통계로만 말한다.
- 판정 문구 금지: 추천 · 비추천 · 합격 · 불합격 · 탈락 · 적합하지 않음 같은 말은 출력 필터(코드)가 막는다.

### 4.3 면접 준비 (`interview_flow`, Pro 이상)

| 단계 | 노드 | 하는 일 | 출력 |
|---|---|---|---|
| 0 | `iv_gate` | 요금제 확인(서버: `assertPlanAllows(employer_interview)`와 같은 규칙). Basic이면 잠금 안내 카드 | – |
| 1 | `iv_inherit` | 이 지원자의 서류 검토 결과를 이어받는다. 없으면 `review_flow`를 먼저 돌린다 | "서류 검토 결과 이어받기 · 확인 필요 N곳" |
| 2 | `iv_design` | 질문 5–8개. 확인 필요였던 부분부터 넣고, 나머지는 공고 핵심 요건 검증 질문으로 채운다 | `InterviewKit` |
| 3 | `iv_screen` | 금지 질문 검사(나이 · 결혼 · 출신 · 가족 · 종교 · 신체 등). 결정적 목록 + 모델 판단 | 걸리면 바꿔 쓴다 |
| 4 | `iv_kit` | 카드로 보여주고 복사 · PDF 저장을 제공한다 | 면접 질문 카드 |

질문마다 넣는 것: 질문, **확인할 점**(무엇을 가려내는 질문인지), 좋은 답의 신호, 주의 신호, 어느 확인 필요 항목에서 왔는지.

### 4.4 인재 찾기와 제안 (`sourcing_flow`, 모든 요금제)

| 단계 | 노드 | 하는 일 |
|---|---|---|
| 1 | `sc_target` | 어떤 공고 또는 역할로 찾을지 정한다 |
| 2 | `sc_search` | `search_profiles`로 공개 프로필만 찾는다(허브에 공개한 사람만, 회사 숨김 설정 존중) |
| 3 | `sc_shortlist` | 공고 요건과 맞는 근거를 프로필별로 2개씩 보여준다. 순위는 매기지 않는다 |
| 4 | `sc_offer` | 담당자가 고른 사람에게 보낼 제안 메시지 초안. 왜 이 사람인지 근거 2개, 역할, 다음 단계. 과장 · 압박 문구 금지 |
| 5 | `sc_send` | `send_offer`(위험한 쓰기, 승인 필요). 프로필마다 한 번만 |

### 4.5 자유 대화와 일반 도구

흐름 밖에서는 지금처럼 `agent ⇄ tools`로 돈다. 공고 목록, 지원자 수, 지원자 단계 변경(위험한 쓰기), 회사 글(위험한 쓰기)처럼 단발성 일을 한다. 단계 변경은 AI가 제안만 하고 담당자가 승인해야 실행된다.

## 5. super-recruit 패키지 (super-resume과 같은 모양)

`services/ai/src/app/resources/super-recruit/`에 둔다. 노드 프롬프트 = 스킬 문서 + 그 단계의 기준 문서.

**스킬 12개**: company-researcher, reference-reader, role-designer, posting-writer, posting-reviewer, document-reader, requirement-matcher, claim-verifier, review-reporter, interview-designer, talent-sourcer, offer-writer

**기준 문서 7개**

| 문서 | 내용 | 쓰는 단계 |
|---|---|---|
| `fair-hiring.md` | 채용절차법 · 고용 차별 금지(성별 · 연령 · 출신 · 혼인 · 신체 등): 공고에 쓰면 안 되는 표현과 바꿀 표현, 면접 금지 질문 | posting-writer, posting-reviewer, interview-designer, offer-writer |
| `posting-writing.md` | 좋은 공고 구조, 하는 일은 대상 · 규모 · 행동으로, 요건은 확인할 수 있게, 연차 범위와 요건 정합성, 근무 조건 필수 항목 | role-designer, posting-writer, posting-reviewer |
| `competency-signals.md` | super-resume의 같은 문서를 공유한다(구직자가 쓰는 기준 = 기업이 읽는 기준) | requirement-matcher, claim-verifier, interview-designer |
| `claim-verification.md` | 4.2.1의 과장 신호 목록, 판단 수준 정의, 인용 규칙, 판정 금지 | claim-verifier, review-reporter |
| `interview-questions.md` | 검증 질문 공식(구체 사례 요청, 시간순 재구성, 다시 한다면, 실패 사례, 측정 방법), 질문당 넣을 항목 | interview-designer |
| `offer-writing.md` | 제안 메시지 공식, 개인정보를 근거로 쓰지 않기, 압박 금지 | offer-writer |
| `writing-voice.md` | 채용 담당자에게 쓰는 해요체, 짧게, 판단보다 근거 먼저 | 모든 단계 |

기준 문서와 스킬 문서는 내가 직접 쓴다. 법 관련 문서(`fair-hiring.md`)는 출처 법령 조문 이름을 적고, 출시 전 개인정보 · 노무 전문가 검토 항목에 넣는다.

## 6. 데이터 모델과 계약

**구조화 출력 (Pydantic, `with_structured_output`)**
- `CompanyProfile{name, summary, facts[{text, sourceUrl}], teams[], recentNews[{title, date, sourceUrl}], refreshedAt}`
- `RoleSpec{need, careerMin, careerMax, mustSkills[], niceSkills[], workStyle, notes}`
- `PostingDraft{title, jobCategory, careerMin, careerMax, location, employmentType, workStyle, salaryRange?, description[], requirements[], preferred[], skills[]}` — 지금 클라이언트가 읽는 `posting-draft` 펜스는 호환을 위해 함께 내보낸다.
- `ReviewReport{applicationId?, attachmentId?, documentsRead[], baseline{used, category, tenureWindow, scoreWindow, sampleCount}, matches[{requirement, status: MET|PARTIAL|MISSING, evidence?}], flags[{title, level: CHECK|SUPPORTED|UNKNOWN, reason, quote?}], summary}`
- `InterviewKit{applicationId, questions[{text, verify, goodSignals[], cautionSignals[], fromFlag?}]}`
- `OfferDraft{profileId, postingId?, message, reasons[2]}`

**저장**
- `companies.profile jsonb, profile_refreshed_at timestamptz` (회사 조사 캐시, 새 migration)
- `employer_reviews(id, company_id, conversation_id, application_id?, attachment_id?, report jsonb, created_at)` — 면접 준비가 이어받는다. 대화를 지우면 같이 지운다.
- `employer_interview_kits(id, company_id, conversation_id, application_id, kit jsonb, created_at)`
- 외부 PDF: 대화 첨부로만 저장(`conversation_id` 범위), **RAG 색인과 참고 데이터 가공에서 제외**, 대화 삭제(관리자만) 때 같이 삭제. 이 규칙은 코드와 테스트로 고정한다.

**이벤트(앱 카드)**: 기존 `choice`, 승인 카드, 문서 이벤트에 아래를 더한다. `employer_research`(출처 목록), `posting_draft`(구조화 초안), `review_report`, `interview_kit`. 계약(`packages/contracts`)에 먼저 넣는다.

**요금제**
| 기능 | Basic | Pro | Ultra |
|---|:-:|:-:|:-:|
| 공고 만들기 · 서류 검토 · 인재 찾기와 제안 | ✓ | ✓ | ✓ |
| 면접 준비 | – | ✓ | ✓ |
| 외부 PDF | – | – | ✓ |
| 모델 · 강도 | Sonnet · MEDIUM | Opus · HIGH | Fable · MAX |
| 참고 연차 · 점수 범위 | ±1년 · 한 단계 위 | ±2년 · 최상위 | 전 연차 · 전 구간 |

요금제 확인은 서버 두 곳에서 한다: 코어(대화 시작 · 메시지)와 Python 흐름 시작 노드. 프롬프트로만 막지 않는다.

## 7. 코드로 막는 장치 (프롬프트만 믿지 않는다)

1. 판정 문구 필터: 기업 하네스 출력에서 추천 · 비추천 · 합격 · 불합격 · 탈락 같은 표현을 찾으면 그 문장을 다시 쓰게 한다.
2. 차별 표현 · 금지 질문 목록: `fair-hiring` 목록을 코드 상수로도 두고, 공고 초안과 면접 질문에 항상 돌린다.
3. 참고 데이터 인용 차단: 기준선 노드는 통계만 넘기고, 템플릿 문장은 모델 입력에 넣지 않는다.
4. 회사 범위: 모든 도구 호출은 코어 API를 회사 담당자 권한으로 부른다(지금 구조 유지). RAG는 `company_id` 필터 없이 쿼리할 수 없다.
5. 외부 PDF 수명: 대화 삭제 시 첨부와 파생 데이터(`employer_reviews` 포함)를 같이 지운다.

## 8. 품질 검증

- **평가 세트** (`services/ai/eval/employer/`): 참고 공고 20개, 직무별 지원 서류 20개(과장을 일부러 심은 것 포함), 정답 라벨.
- **지표와 기준**
  - 심어 둔 과장 중 "확인 필요"로 잡은 비율 80% 이상, 근거 충분인 문장을 잘못 잡은 비율 20% 이하
  - 공고 초안의 차별 표현 0건, 면접 금지 질문 0건
  - 판정 문구 0건, 참고 데이터 문장 인용 0건
  - 참고 공고와 문장 유사도 기준 이하
- CI에서는 가짜 모델로 흐름 · 필터 · 범위 테스트를 돌리고, 실제 모델 평가는 VPS에서 배포 전에 돌린다.

## 9. 만드는 순서 (Opus가 직접)

Track L(LangChain 기반)과 Track H(하위 그래프 패턴)가 머지된 뒤 시작한다. 각 단계는 PR 하나이고, 끝날 때마다 배포까지 확인한다.

| PR | 내용 | 증명하는 테스트 |
|---|---|---|
| E1 | super-recruit 패키지: 스킬 12개 · 기준 문서 7개, 단계별 기준 문서 매핑 | 매핑 테스트, 문서 존재 테스트 |
| E2 | 계약과 저장: 이벤트 4종, `companies.profile`, `employer_reviews`, `employer_interview_kits` migration | 계약 테스트, migration 테스트 |
| E3 | 기업 그래프 뼈대: route · agent · 시작 도구 · 흐름 진입과 복귀, `EMPLOYER_GATE` 승인 카드 | 흐름 진입 · 그만하기 · 재시작 후 이어가기 |
| E4 | 공고 만들기 흐름 + 공고 검수(차별 표현 목록 포함) | 참고 공고 문장 복사 차단, 차별 표현 0, GATE 순서 |
| E5 | 서류 검토 흐름 + 기준선(30개 규칙, 요금제 범위) + 과장 판별 + 판정 문구 필터 | 기준선 없는 구간은 비교하지 않음, 인용은 지원자 서류에서만, 판정 문구 0 |
| E6 | 면접 준비 흐름(Pro 게이트) + 금지 질문 검사 + PDF | Basic 잠금, 검토 결과 이어받기, 금지 질문 0 |
| E7 | 외부 PDF(Ultra) 수명 규칙 | 색인 · 참고 데이터 제외, 대화 삭제 시 함께 삭제 |
| E8 | 인재 찾기와 제안 흐름 | 공개 프로필만, 프로필당 제안 한 번, 승인 없이는 안 보냄 |
| E9 | 평가 세트와 기준 통과 확인, 예전 경로의 기업 기능 제거 준비(Track F1 선행 조건) | 평가 지표가 8장 기준 이상 |

## 10. 내가 정한 것 (검토해 주세요)

1. 기업 패키지 이름을 `super-recruit`으로 하고 super-resume과 같은 모양(스킬 + 기준 문서)으로 만든다.
2. 네 번째 흐름으로 "인재 찾기와 제안"을 넣는다. docs의 허브 제안 기능과 지금 코드의 도구를 흐름으로 묶은 것이다.
3. 여러 지원자를 한 표로 비교하는 기능은 이번에 넣지 않는다(편향 위험).
4. `competency-signals.md`는 super-resume 것을 그대로 같이 쓴다.
5. 회사 조사 결과를 30일 캐시한다.
6. 판정 문구 · 차별 표현 · 금지 질문은 프롬프트와 코드 필터 둘 다로 막는다.
7. 외부 PDF는 RAG에 색인하지 않고 대화 첨부로만 둔다.
8. 서류 검토 결과와 면접 질문을 DB에 저장해서, 같은 회사 담당자가 이어서 볼 수 있게 한다(대화와 함께 삭제).
