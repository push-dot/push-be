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

func TestInterviewCompanySourcesPersistAndGroundResearch(t *testing.T) {
	s := testApp(t)
	_, app := jobApp(t, s)
	_, other := jobApp(t, s)
	source := map[string]any{"sourceUrl": "https://example.com/company", "sourceText": "회사는 공개 API를 제공합니다.", "accessedAt": "2026-01-01T00:00:00Z"}
	body := map[string]any{"applicationId": id(app), "title": "면접", "scheduledAt": "2026-10-01T00:00:00Z", "evidenceIds": []string{}, "companySources": []any{source}}
	session := data(request(t, s, "POST", "/interviews", body, 201))
	saved := data(request(t, s, "GET", "/interviews/"+id(session), nil, 200))
	if len(saved["companySources"].([]any)) != 1 {
		t.Fatal(saved)
	}
	otherList := request(t, s, "GET", "/interviews?applicationId="+id(other), nil, 200)
	if len(otherList["data"].([]any)) != 0 {
		t.Fatal(otherList)
	}
	for _, patch := range []map[string]any{{"sourceUrl": "http://example.com", "sourceText": "text", "accessedAt": "2026-01-01T00:00:00Z"}, {"sourceUrl": "https://example.com", "sourceText": "", "accessedAt": "2026-01-01T00:00:00Z"}, {"sourceUrl": "https://example.com", "sourceText": "text", "accessedAt": "2999-01-01T00:00:00Z"}} {
		request(t, s, "PATCH", "/interviews/"+id(session), map[string]any{"expectedRevision": 1, "companySources": []any{patch}}, 400)
	}
	patched := data(request(t, s, "PATCH", "/interviews/"+id(session), map[string]any{"expectedRevision": 1, "companySources": []any{source}}, 200))
	if len(patched["companySources"].([]any)) != 1 {
		t.Fatal(patched)
	}
	check := func(value map[string]any) {
		t.Helper()
		research := value["research"].([]any)
		if len(research) != 1 {
			t.Fatal(value)
		}
		r := research[0].(map[string]any)
		if r["claim"] != source["sourceText"] || r["sourceUrl"] != source["sourceUrl"] || r["accessedAt"] != source["accessedAt"] || r["verificationStatus"] != "USER_PROVIDED" {
			t.Fatal(r)
		}
	}
	check(opResult(t, request(t, s, "POST", "/interviews/"+id(session)+"/prepare", map[string]any{"expectedRevision": 2, "ai": nil}, 202)).(map[string]any))
	s.Config.Models = []ModelConfig{{Provider: "OPENAI", Model: "test"}}
	request(t, s, "PUT", "/ai/keys/OPENAI", map[string]any{"key": "sk-secret-123456789"}, 200)
	fabricated := false
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(raw), source["sourceText"].(string)) || !strings.Contains(string(raw), source["sourceUrl"].(string)) {
			t.Error("missing company source", string(raw))
		}
		reply := `{"questions":[],"starAnswers":[],"research":[]}`
		if fabricated {
			reply = `{"questions":[],"starAnswers":[],"research":[{"claim":"Invented revenue","sourceUrl":"https://invented.example"}]}`
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": reply}}}, "usage": map[string]any{"prompt_tokens": 20, "completion_tokens": 8}})
	}))
	defer provider.Close()
	s.HTTP = &http.Client{Transport: redirectTransport{target: provider.Listener.Addr().String()}}
	for _, bad := range []bool{false, true} {
		fabricated = bad
		op := data(request(t, s, "POST", "/interviews/"+id(session)+"/prepare", map[string]any{"expectedRevision": 2, "ai": map[string]any{"provider": "OPENAI", "model": "test", "credentialMode": "BYOK", "effort": "LOW"}}, 202))
		var queued []byte
		if e := s.DB.QueryRow(context.Background(), "SELECT input FROM work_queue WHERE operation_id=$1", id(op)).Scan(&queued); e != nil {
			t.Fatal(e)
		}
		var snapshot AIJob
		if e := json.Unmarshal(queued, &snapshot); e != nil {
			t.Fatal(e)
		}
		if len(snapshot.CompanySources) != 1 || snapshot.CompanySources[0].SourceText != source["sourceText"] {
			t.Fatal("company source snapshot missing", string(queued))
		}
		if e := s.ProcessOne(context.Background()); e != nil {
			t.Fatal(e)
		}
		result := request(t, s, "GET", "/operations/"+id(op), nil, 200)
		if bad {
			if data(result)["status"] != "FAILED" {
				t.Fatal(result)
			}
		} else {
			check(opResult(t, result).(map[string]any))
		}
	}
}
