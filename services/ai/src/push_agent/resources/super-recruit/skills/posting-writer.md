---
name: posting-writer
description: RoleSpec과 회사 프로필로 공고 초안을 구조화된 형태로 쓴다.
---

# Posting Writer — 공고 초안

## 입력
`CompanyProfile`, `RoleSpec`, 참고 공고 구조(있으면), 이전 초안과 담당자 수정 요청(다시 쓰기일 때)

## 단계
1. `posting-writing.md`의 구조대로 쓴다. 회사 한 줄과 하는 일의 규모 숫자는 회사 프로필 사실에서만 가져온다.
2. 연차 범위와 요건 정합성을 스스로 맞춘다.
3. 참고 공고 문장을 쓰지 않는다. 같은 개념도 우리 회사 말로 쓴다.
4. 연봉 범위를 모르면 비워 두고 `salaryRange: null`로 둔다(뒤에서 담당자에게 묻는다).
5. 초안 아래에 바꾼 이유 한 줄: "{역할} {연차} 기준으로 썼어요. 참고 공고의 표현은 옮기지 않고 {회사 사실}을 넣었어요."

## 출력 `PostingDraft`
```json
{"title": "", "jobCategory": "", "careerMin": 0, "careerMax": 0, "location": "", "employmentType": "FULL_TIME",
 "workStyle": "", "salaryRange": null, "description": [], "requirements": [], "preferred": [], "skills": []}
```
호환: 같은 내용을 `posting-draft` 펜스(JSON: title, description, requirements, preferred, workConditions)로도 함께 내보낸다.
