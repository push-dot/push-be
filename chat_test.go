package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChatGroundsSelectedImmutableVersionAndAttachments(t *testing.T) {
	s := testApp(t)
	job, app := jobApp(t, s)
	_, other := jobApp(t, s)
	s.Config.Models = []ModelConfig{{Provider: "OPENAI", Model: "test"}}
	request(t, s, "PUT", "/ai/keys/OPENAI", map[string]any{"key": "sk-secret-123456789"}, 200)
	evidence := data(request(t, s, "POST", "/career-evidence", map[string]any{"kind": "CAREER", "title": "API", "sourceText": "Go API 응답 시간을 20% 줄였습니다.", "skills": []string{"Go"}}, 201))
	approve(t, s, "EVIDENCE_USE", id(app), id(evidence))
	doc := data(request(t, s, "POST", "/documents", map[string]any{"applicationId": id(app), "title": "Selected resume", "kind": "RESUME", "template": "CLASSIC"}, 201))
	version := data(request(t, s, "POST", "/documents/"+id(doc)+"/versions", versionInput(id(evidence), "Go API 응답 시간을 20% 줄였습니다."), 201))["version"].(map[string]any)
	conv := data(request(t, s, "POST", "/conversations", map[string]any{"applicationId": id(app), "title": "Review"}, 201))
	foreign := data(request(t, s, "POST", "/conversations", map[string]any{"applicationId": id(other), "title": "Other"}, 201))
	payload := map[string]any{"text": "Review this version", "context": map[string]any{"documentId": id(doc), "versionId": id(version), "evidenceIds": []string{}}, "ai": map[string]any{"provider": "OPENAI", "model": "test", "credentialMode": "BYOK", "effort": "LOW"}, "accessMode": "SUGGEST"}
	request(t, s, "POST", "/conversations/"+id(foreign)+"/messages", payload, 400)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		for _, want := range []string{id(job), "Go PostgreSQL 개발", "테스트 회사", id(version), id(evidence), "Go API 응답 시간을 20% 줄였습니다."} {
			if !strings.Contains(string(raw), want) {
				t.Errorf("missing context %s: %s", want, raw)
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "Review proposal"}}}, "usage": map[string]any{"prompt_tokens": 20, "completion_tokens": 8}})
	}))
	defer provider.Close()
	s.HTTP = &http.Client{Transport: redirectTransport{target: provider.Listener.Addr().String()}}
	op := data(request(t, s, "POST", "/conversations/"+id(conv)+"/messages", payload, 202))
	request(t, s, "PATCH", "/jobs/"+id(job), map[string]any{"expectedRevision": 1, "company": "CHANGED AFTER ENQUEUE"}, 200)
	if e := s.ProcessOne(context.Background()); e != nil {
		t.Fatal(e)
	}
	value := opResult(t, request(t, s, "GET", "/operations/"+id(op), nil, 200)).(map[string]any)
	message := value["assistantMessage"].(map[string]any)
	attachments := message["attachments"].([]any)
	if len(attachments) != 2 {
		t.Fatal("missing attachments", message)
	}
	for _, raw := range attachments {
		a := raw.(map[string]any)
		switch a["type"] {
		case "DOCUMENT_VERSION":
			if a["documentId"] != id(doc) || a["id"] != id(version) {
				t.Fatal(a)
			}
			request(t, s, "GET", "/documents/"+id(doc)+"/versions/"+id(version), nil, 200)
		case "EVIDENCE":
			if a["id"] != id(evidence) {
				t.Fatal(a)
			}
			request(t, s, "GET", "/career-evidence/"+id(evidence), nil, 200)
		default:
			t.Fatal(a)
		}
	}
	request(t, s, "POST", "/career-evidence/"+id(evidence)+"/archive", map[string]any{"expectedRevision": 1}, 200)
	request(t, s, "POST", "/conversations/"+id(conv)+"/messages", payload, 409)

}
