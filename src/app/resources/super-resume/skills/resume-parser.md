---
name: resume-parser
description: >
  사용자의 이력서를 파싱하여 구조화된 데이터로 변환. 마크다운(.md), PDF, 일반 텍스트 입력을 지원.
  이력서 파일을 읽어 개인정보, 경력, 프로젝트, 기술스택, 학력, 자격증 등으로 분류해야 하는 경우
  반드시 이 스킬을 사용할 것. 입력 분석가(Input Analyzer)가 이 스킬을 로드하여 사용한다.
---

# Resume Parser — 이력서 파싱 스킬

다양한 형식의 이력서를 구조화된 JSON 데이터로 변환하는 스킬.

## 실행 조건
- 사용자가 이력서 파일(.md, .pdf), URL, 또는 텍스트를 제공한 경우
- 이력서 내용을 섹션별로 분류해야 하는 경우
- 기존 이력서의 구조를 유지하면서 데이터를 추출해야 하는 경우

## 워크플로우
### Step 1: 입력 형식 감지 및 읽기
1. 입력이 **파일 경로**인지, **URL**인지, **직접 텍스트**인지 확인
2. **파일 경로**:
   - `.md` 파일 → Read 도구로 읽기
   - `.pdf` 파일 → 먼저 `opendataloader-pdf` 사용 가능 여부를 확인한다. 사용 가능하면 이를 우선 사용해 텍스트, 문서 구조, 링크/annotation을 추출한다. `opendataloader-pdf`가 없거나 실패하면 Read 또는 look_at 도구로 텍스트를 추출한다. **반드시 PDF hyperlink annotation/link target도 함께 추출**하여 `Github`/`포트폴리오`처럼 화면에는 라벨만 보이는 링크의 실제 URL을 복원한다. Read/look_at이 링크 target을 제공하지 못하면 Python(`pypdf` 또는 `pdfplumber`)으로 annotation을 추출한다. 필요한 패키지가 없으면 설치 후 재시도한다.
   - 다른 형식 → "지원하지 않는 형식입니다" 안내
3. **URL** (http:// 또는 https://로 시작):
   - **3단계 URL Fetching 전략** 사용 (아래 섹션 참고)
4. **직접 텍스트** → 그대로 사용


### Step 1-B: PDF hyperlink annotation 추출

PDF 입력에서는 텍스트 추출만으로 충분하지 않다. Rallit/Wanted/Notion 등에서 내보낸 이력서는 화면에 `Github`, `포트폴리오`, 프로젝트명만 보이고 실제 URL은 PDF annotation/link target에만 들어갈 수 있다.

1. PDF 파일을 읽을 때 먼저 `command -v opendataloader-pdf` 등으로 사용 가능 여부를 확인한다.
2. `opendataloader-pdf`가 있으면 이를 우선 사용해 텍스트/구조/링크를 추출하고, 결과를 `_workspace/01_pdf_opendataloader_output.*` 형태로 보존한다. 출력 형식은 설치된 도구가 지원하는 형식에 맞추되, 가능한 경우 JSON 또는 Markdown을 선호한다.
3. `opendataloader-pdf`가 없거나 실행 실패, 링크 누락, 텍스트 품질 저하가 있으면 기존 fallback(Read/look_at → Python `pypdf`/`pdfplumber`)을 사용한다.
4. 어떤 방법을 사용하든 텍스트와 별도로 각 페이지의 hyperlink annotation을 추출한다.
5. annotation에서 다음 URL을 수집한다:
   - `https://github.com/...`, `github.com/...`
   - 포트폴리오, 개인 사이트, 프로젝트 배포 URL
   - LinkedIn, Notion, Rallit 등 프로필 URL
6. 추출한 링크는 `_workspace/01_extracted_links.json`에 저장한다.
7. 링크 텍스트 또는 annotation 위치가 `Github`, `깃허브`, 프로젝트 섹션 근처이면 다음처럼 매핑한다:
   - 개인 GitHub 프로필 → `personal_info.github`
   - 프로젝트 GitHub 레포 → 해당 `projects[].url` 또는 `projects[].links.github`
   - 포트폴리오 URL → `personal_info.links`
8. PDF annotation에서 GitHub URL을 찾았으면 `missing_inputs.github_url`을 설정하지 않는다.
9. 텍스트에는 GitHub 항목이 있지만 annotation에도 URL이 없을 때만 `missing_inputs.github_url: true`로 기록한다.

Python fallback 예시:

```python
from pypdf import PdfReader

reader = PdfReader(pdf_path)
links = []
for page_index, page in enumerate(reader.pages):
    for annot in page.get('/Annots', []) or []:
        obj = annot.get_object()
        action = obj.get('/A')
        if action and action.get('/URI'):
            links.append({'page': page_index + 1, 'uri': str(action.get('/URI'))})
```

### URL Fetching 전략 (3단계 Fallback)

URL이 제공된 경우, 다음 순서로 시도하라:

#### 1단계: webfetch (기본)
1. `webfetch` 도구로 URL 내용 가져오기
2. 결과가 markdown/텍스트이고 **이력서 내용이 충분히 포함되어 있으면** → 직접 파싱
3. 결과가 PDF 바이너리면 → `look_at`으로 텍스트 추출
4. 결과가 **HTML 네비게이션/푸터만 있고 실제 콘텐츠가 없거나**, 요청이 실패하면 → 1회 재시도
5. 재시도도 실패하면 → **2단계(Playwright)** 로 fallback

#### 2단계: Playwright 브라우저 렌더링 (JS 실행 필요 시)
> `skill("playwright")` 로드 필요. webfetch로 내용을 얻을 수 없는 동적 페이지에 사용.

1. Playwright MCP의 `browser_navigate`로 URL 접속
2. 페이지 로딩 완료 후 `browser_snapshot`으로 접근성 트리 얻기
3. 접근성 트리에서 이력서 관련 텍스트 노드 추출:
   - `heading`, `paragraph`, `term`, `definition`, `listitem` 등 구조화된 텍스트 수집
   - 각 섹션별로 정보 분류 (기본정보, 기술스택, 경력, 프로젝트, 교육, 활동 등)
4. 결과가 있으면 → 추출된 텍스트로 파싱 진행
5. **일부 섹션이 "공개 제한"/"로그인 필요" 등으로 가려진 경우**:
   - 추출 가능한 정보만 저장
   - 보이지 않는 섹션은 누락으로 표시
   - 사용자에게 보고: "**플랫폼명**에서 **N**개 섹션을 읽었고, **M**개 섹션은 로그인이 필요합니다."

#### 3단계: 플랫폼별 가이드 제공 (읽을 수 없는 경우)

2단계까지 실패하거나, 중요한 섹션이 모두 가려진 경우:

1. URL에서 플랫폼 감지 (rallit.com, wanted.co.kr, linkedin.com, career.programmers.co.kr 등)
2. 사용자에게 플랫폼별 안내 제공:

| 플랫폼 | 문제 | 해결 방법 |
|--------|------|----------|
| **rallit.com** (허브) | 경력/프로젝트 섹션이 "허브 공개 제한"으로 가려짐 | ① 랠릿 허브에서 프로필 공개 설정 변경<br>② 이력서를 PDF로 내보내기 후 파일 업로드<br>③ 텍스트로 직접 붙여넣기 |
| **wanted.co.kr** | 일부 내용이 로그인 필요 | PDF 내보내기 또는 텍스트 붙여넣기 |
| **linkedin.com** | 대부분 로그인 필요 | LinkedIn에서 PDF로 내보내기 후 업로드 |
| **programmers.co.kr** | 이력서가 로그인 필요 | PDF 내보내기 또는 텍스트 붙여넣기 |

3. "URL로 읽을 수 있는 정보가 제한적입니다. 이력서를 PDF나 텍스트로 제공해주시면 더 정확하게 처리할 수 있습니다."

### 추출 결과 표시 예시
URL fetching 완료 후, 추출된 정보를 사용자에게 요약해서 보여줘라:

```
📄 랠릿 허브 — 채영준 프로필
  ✅ 기본 정보 (이름, 이메일, 소개)
  ✅ 기술 스택 (React, Next.js, TypeScript, ...)
  ✅ 교육 (더조은컴퓨터아카데미, 서울디지텍고)
  ✅ 대외활동 (기능경기대회, 해커톤)
  ⛔ 경력 (허브 공개 제한 — 로그인 필요)
  ⛔ 프로젝트 (허브 공개 제한 — 로그인 필요)

🔔 경력과 프로젝트를 읽을 수 없습니다.
   이력서 PDF 파일을 업로드하거나 텍스트를 붙여넣어 주세요.
```

### Step 2: 섹션 분류 및 구조화
1. 이력서 텍스트를 다음 섹션으로 분류:
   - `personal_info`: 이름, 연락처, 링크 (GitHub, LinkedIn, 포트폴리오), `profile_image` (프로필 사진 경로 또는 null)
     - 실제 GitHub URL이 텍스트나 PDF annotation에서 발견되면 `personal_info.github` 또는 `personal_info.links`에 저장
     - 프로젝트별 GitHub 레포 URL이 텍스트나 PDF annotation에서 발견되면 해당 `projects[].url` 또는 `projects[].links.github`에 저장
     - `GitHub`, `Github`, `깃허브`, `Git Hub` 항목은 있으나 텍스트와 PDF annotation 어디에도 실제 URL이 없으면 `personal_info.github_label_present: true`, `personal_info.github: null`, `missing_inputs.github_url: true`로 기록
   - `summary`: 자기소개/프로필 요약
   - `skills`: 기술 스택 (카테고리별 분류)
   - `experience`: 경력 (회사, 기간, 역할, 성과)
   - `projects`: 프로젝트 (기술 스택, 기여 내용, 성과)
   - `education`: 학력
   - `certifications`: 자격증/교육
   - `other`: 기타 섹션
2. 각 섹션 내에서 중복되거나 모순되는 정보 식별
3. GitHub 항목만 있고 URL이 없는 경우는 누락 입력으로 보존한다. 임의로 스킵하거나 GitHub 탐색이 필요 없다고 판단하지 않는다.

### Step 3: JSON 출력 생성
1. `_workspace/01_parsed_resume.json`에 저장 (프로필 이미지 경로 포함)
2. 원본 마크다운도 `_workspace/01_original_resume.md`에 보존

## 원칙
- 원본 데이터를 절대 변경하지 말고, 파싱 결과는 원본과 별도로 저장하라 — 사용자가 원본과 비교할 수 있어야 한다
- PDF에서 텍스트 추출이 완벽하지 않을 수 있음을 인지하고, 추출 실패 시 "텍스트 추출 불가"로 표시하라
- 섹션 이름은 사용자가 사용한 원본 섹션명을 유지하되, 표준 분류에 매핑하라
- GitHub 항목은 있는데 URL이 없으면 사용자 의도가 남아있는 것으로 보고 `missing_inputs.github_url`에 반드시 기록하라
- **URL의 모든 섹션을 읽지 못해도 포기하지 마라** — 읽을 수 있는 정보라도 최대한 활용하고, 누락을 사용자에게 명확히 알려라

## 검증
- [ ] 모든 섹션이 올바르게 분류되었는가?
- [ ] 원본 데이터가 보존되었는가?
- [ ] JSON 형식이 유효한가?
- [ ] GitHub 항목만 있고 URL이 없는 경우 `missing_inputs.github_url`이 기록되었는가?
- [ ] PDF 텍스트 추출이 성공했는가?
- [ ] PDF hyperlink annotation/link target을 추출하고 `_workspace/01_extracted_links.json`에 보존했는가?
- [ ] URL에서 읽지 못한 섹션이 있다면 fetch_warnings에 기록되었는가?

## 참고
- PDF 처리: `opendataloader-pdf`가 있으면 최우선 사용. 없거나 실패하면 Read 도구로 PDF 텍스트 추출을 시도하고, 추출 품질이 낮으면 look_at 도구로 보완. 둘 다 실패하거나 링크 target이 누락되면 `pypdf`/`pdfplumber`(Python)로 폴백 시도
- 출력 경로는 항상 `_workspace/` 디렉토리 사용
- Playwright 사용 시 `skill("playwright")`로 스킬 로드 후 `skill_mcp(mcp_name="playwright", tool_name="browser_navigate", ...)` 호출
