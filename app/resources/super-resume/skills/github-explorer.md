---
name: github-explorer
description: >
  사용자의 GitHub 저장소를 탐색하여 이력서에 포함할 프로젝트와 경험을 발굴.
  레포 README 분석, 기술 스택 추출, 커밋 히스토리 스캔, Contribution 그래프 분석.
  사용자가 GitHub URL이나 username을 제공했을 때, 또는 현재 이력서에 경험이
  부족할 때 반드시 이 스킬을 사용할 것. 공고 키워드와 매칭되는 레포를 우선 탐색.
---

# GitHub Explorer — GitHub 저장소 탐색 스킬

사용자의 GitHub 저장소를 분석하여 이력서에 추가할 프로젝트, 기술 스택, contribution 내역을 발굴하는 스킬.

## 실행 조건
- 이력서에서 GitHub 프로필/레포 URL이 발견된 경우
- 이력서에 경험이 부족하여 추가 프로젝트가 필요한 경우  
- 공고 요구사항과 일치하는 저장소가 있는지 확인해야 하는 경우
- 이력서에 기재된 경험을 GitHub 활동으로 검증해야 하는 경우

## 워크플로우
### Step 0: 이력서의 GitHub URL 추출
이 스킬은 외부에서 호출될 때 `_workspace/01_parsed_resume.json`을 읽어서
GitHub URL을 자동으로 추출한다:

```json
{
  "personal_info": {
    "github": "https://github.com/cyjoon68",
    "links": ["https://github.com/cyjoon68/project-a", "..."]
  }
}
```

발견된 GitHub 프로필/레포 URL을 기반으로 탐색을 시작한다.

GitHub 링크가 없더라도 `_workspace/01_parsed_resume.json` 또는 `_workspace/01_scenario.json`에 `missing_inputs.github_url: true`가 있으면 결과 없음을 반환하지 않는다. 이 상태는 "GitHub 항목은 있으나 실제 URL이 없는 경우"이므로 오케스트레이터에 사용자 확인이 필요하다고 보고한다.

```json
{
  "status": "needs_user_input",
  "missing_inputs": {"github_url": true},
  "message": "이력서에 GitHub 항목이 있지만 URL이 없습니다. GitHub 프로필이나 레포 링크를 제공받아야 저장소 탐색을 진행할 수 있습니다."
}
```

GitHub 링크도 없고 `missing_inputs.github_url`도 없을 때만 이 스킬은 건너뛰고 결과 없음을 반환한다.

### Step 0-B: GitHub 액세스 방식 결정
플랫폼에서 사용 가능한 도구에 따라 GitHub 접근 방식을 선택:
1. **`gh` CLI**: `gh repo list`, `gh search repos` 등 GitHub CLI 명령어 사용 (가장 강력)
2. **GitHub API via webfetch**: `https://api.github.com/users/{username}/repos` 등 REST API 호출
3. **GitHub 웹페이지 스크래핑**: webfetch로 프로필 페이지, 레포 페이지 읽기
4. **git clone + 로컬 분석**: (가능한 경우) 레포를 클론하여 로컬에서 분석

### Step 1: 저장소 목록 수집
다음 정보를 수집:
1. 사용자의 Public 저장소 목록
2. 각 저장소의 기본 정보: 이름, 설명, 언어, 스타 수, 포크 수, 마지막 업데이트
3. 기여한 저장소 (Contribution 기록이 있는 저장소)
4. Pin된 저장소 (사용자가 강조하는 프로젝트)

### Step 2: 이력서 중복 검사
각 저장소를 파싱된 이력서(`_workspace/01_parsed_resume.json`)에 기재된
프로젝트/회사/경험과 비교하여 **이미 이력서에 있는지** 판단:

1. **직접 매칭**: 이력서의 `projects[].name`이나 `projects[].url`이 레포 URL과 일치
2. **이름/설명 유사도**: 이력서 프로젝트 이름이나 설명에 레포 이름이 포함됨
3. **기술 스택 교집합**: 이력서 경험의 기술 스택과 레포의 기술 스택이 50% 이상 일치 + 유사한 프로젝트 설명

각 레포에 `already_in_resume: true/false`와 근거(`match_evidence`)를 기록:

```json
{
  "name": "go-cli-tool",
  "already_in_resume": false,
  "match_evidence": "이력서의 어떤 프로젝트와도 이름/설명/URL이 일치하지 않음"
}
```

```json
{
  "name": "kafka-pipeline",
  "already_in_resume": true,
  "match_evidence": "이력서 'experience[1].projects[0].name' == 'kafka-pipeline'"
}
```

### Step 3: 공고 매칭 저장소 필터링
콘텐츠 전략가의 분석 결과(job_analyses.json)를 참조하여:
1. 공고 요구사항과 **기술 스택이 일치하는** 저장소를 우선 선별
2. 공고 요구사항과 **도메인이 일치하는** 저장소를 다음 순위로 선별
3. 최근 활동(최근 1년 내 커밋)이 있는 저장소를 우선
4. 스타/포크 수가 높은 저장소를 우선

### Step 3: 선별된 저장소 상세 분석
각 선별된 저장소에 대해:
1. **README.md** 읽기 — 프로젝트 설명, 기술 스택, 주요 기능 파악
2. **기술 스택 추출**: package.json, requirements.txt, go.mod 등 의존성 파일 확인
   - 또는 README의 배지/기술 스택 섹션에서 추출
3. **최근 커밋 로그**: 최근 10개 커밋 메시지에서 주요 작업 파악
4. **Contribution 통계**: 기여 횟수, 기간, 주요 기여 영역
5. **CI/테스트 설정**: GitHub Actions 등 자동화 경험 증명

접근할 수 없는 경우(API 제한, 프라이빗 레포):
- "접근 불가"로 표시하고 가능한 정보만 수집
- 프라이빗 레포는 사용자에게 직접 내용을 요청

### Step 4: STAR 형식 프로젝트 설명 초안 생성
각 저장소에 대해 이력서에 포함할 STAR 설명 초안 작성:
- **S**ituation: 프로젝트의 배경/문제
- **T**ask: 본인의 역할과 기여
- **A**ction: 구체적으로 수행한 작업 (커밋 메시지, PR 기반)
- **R**esult: 레포의 성과 (스타 수, 사용자 수 등 알 수 있는 범위 내)

### Step 5: 발견된 경험 구조화하여 출력
`_workspace/01_github_findings.json`에 저장:

```json
{
  "username": "cyjoon68",
  "repos_scanned": 12,
  "repos_matched": 3,
  "matched_repos": [
    {
      "name": "super-resume",
      "full_name": "cyjoon68/super-resume",
      "description": "AI-powered resume tailoring",
      "language": "Python",
      "stars": 5,
      "topics": ["resume", "ai-agent", "tailoring"],
      "readme_summary": "...",
      "tech_stack": ["Python", "OpenCode", "Markdown"],
      "recent_commits": 14,
      "contribution_period": "2026-04 ~ 2026-05",
      "star_draft": "...",
      "match_reason": "공고 요구사항 'AI Agent 경험'과 일치",
      "resume_relevance": "high",
      "already_in_resume": true,
      "match_evidence": "이력서 projects[2].name == 'super-resume'"
    }
  ],
  "unmatched_repos": ["...", "..."],
  "new_discoveries": [
    {
      "repo_name": "go-cli-tool",
      "full_name": "cyjoon68/go-cli-tool",
      "description": "A CLI tool for automating deployments",
      "tech_stack": ["Go", "Cobra", "Docker"],
      "stars": 8,
      "match_reason": "공고 'Go 개발자' 요구사항과 매칭",
      "already_in_resume": false,
      "star_draft": "..."
    }
  ]
}
```

## 원칙
- **실제 데이터에 기반하라** — 추정하지 말고, GitHub에서 확인된 정보만 기록하라
- **프라이빗 레포는 사용자 허락을 받아라** — 접근 권한이 없으면 사용자에게 내용을 직접 요청하라
- **중복을 검사하라** — 이미 이력서에 있는 프로젝트는 `already_in_resume: true`로 표시하고, 오케스트레이터가 자동 반영한다. 이 스킬은 직접 넣거나 빼지 않고 데이터만 제공한다
- **새 발견은 판단하지 마라** — 이력서에 없는 경험은 `already_in_resume: false`로만 표시하고, 추가 여부는 오케스트레이터가 사용자에게 묻도록 한다. 이 스킬이 임의로 추가 결정을 내리지 마라
- **과대포장하지 마라** — 스타 3개 받은 토이 프로젝트를 "널리 사용된"이라고 표현하지 마라
- **레포의 목적을 이해하라** — 개인 학습용 저장소와 프로덕션 프로젝트를 구분하라

### Step 0-C: GitHub URL 누락 상태 처리

1. 실제 GitHub URL이 있으면 정상 탐색을 진행한다.
2. 실제 GitHub URL은 없지만 `missing_inputs.github_url: true`이면 `needs_user_input` 상태를 반환한다.
3. 실제 GitHub URL도 없고 누락 표시도 없으면 `skipped` 상태를 반환한다.
4. `needs_user_input`과 `skipped`를 구분하여 오케스트레이터가 silent skip하지 않게 한다.

## 검증
- [ ] 모든 스캔된 레포가 목록화되었는가?
- [ ] 공고 매칭 레포가 올바르게 필터링되었는가?
- [ ] 각 매칭 레포에 match_reason이 명시되었는가?
- [ ] 각 매칭 레포에 STAR 초안이 작성되었는가?
- [ ] 새로운 발견 사항이 식별되었는가?
- [ ] 중복(이미 이력서에 있는) 레포가 표시되었는가?
- [ ] 접근 불가 레포가 기록되었는가?

## 참고
- GitHub API rate limit: 인증되지 않은 요청은 시간당 60회, 인증된 요청은 5000회
- `Authorization: token {gh_token}` 헤더로 인증 가능
- `gh` CLI가 설치되어 있으면 `gh api`로 더 많은 정보 획득 가능
