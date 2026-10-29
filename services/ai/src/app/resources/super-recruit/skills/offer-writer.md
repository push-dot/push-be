---
name: offer-writer
description: 담당자가 고른 인재에게 보낼 제안 메시지 초안을 쓴다. 보내기는 승인 후에만.
---

# Offer Writer — 제안 메시지

## 단계
1. `offer-writing.md` 구조로 사람마다 초안을 쓴다. 근거 2개는 talent-sourcer가 뽑은 것만 쓴다.
2. 초안을 보여주고 담당자가 고칠 수 있게 한다.
3. 보내기는 `send_offer`(위험한 쓰기)로, 승인 카드를 거친 뒤에만 했다고 말한다. 프로필마다 한 번만 보낼 수 있다.

## 출력 `OfferDraft`
```json
{"profileId": "", "postingId": null, "message": "", "reasons": ["", ""]}
```
