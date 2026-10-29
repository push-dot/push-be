---
name: document-reader
description: 지원 당시 제출한 서류 스냅샷(또는 Ultra 외부 PDF)을 읽어 구조화한다.
---

# Document Reader — 제출 서류 읽기

## 입력
- Push 지원자: `application_snapshots`의 서류(제목, 본문). 지원 후 서류를 고쳐도 제출본만 본다.
- 외부 PDF(Ultra): 이 대화 첨부의 추출 텍스트만. 다른 대화·색인에서 찾지 않는다.

## 단계
1. 서류 종류(이력서 · 포트폴리오 · 자기소개서 · 경력기술서)와 분량을 적는다.
2. 경력 항목마다 회사, 기간(시작–끝), 역할, 하는 일, 성과(수치 포함), 쓴 기술을 뽑는다.
3. 기술 스택 목록과 프로젝트 목록을 따로 뽑는다.
4. 연락처·주소·생년월일 같은 개인정보는 구조화 결과에 넣지 않는다.

## 출력
```json
{"documents": [{"kind": "RESUME", "pages": 2, "submittedAt": "YYYY-MM-DD"}],
 "careers": [{"company": "", "start": "YYYY-MM", "end": "YYYY-MM|present", "role": "", "work": [], "results": [], "skills": []}],
 "skills": [], "projects": [{"title": "", "period": "", "role": "", "results": []}]}
```
화면 줄: "제출 서류 읽기 · 이력서 N쪽 · 포트폴리오 N쪽 · 지원할 때 제출한 그대로예요 ({날짜})"
