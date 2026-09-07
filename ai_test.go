package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type redirectTransport struct{ target string }

func (t redirectTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r.URL.Scheme = "http"
	r.URL.Host = t.target
	return http.DefaultTransport.RoundTrip(r)
}
func TestAIQueuedActualProviderUsageAndSecretIsolation(t *testing.T) {
	s := testApp(t)
	_, a := jobApp(t, s)
	s.Config.Models = []ModelConfig{{Provider: "OPENAI", Model: "test-model"}}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer sk-secret-123456789" {
			t.Errorf("provider request mismatch %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "검토용 제안"}}}, "usage": map[string]any{"prompt_tokens": 20, "completion_tokens": 8}})
	}))
	defer provider.Close()
	s.HTTP = &http.Client{Transport: redirectTransport{target: provider.Listener.Addr().String()}}
	request(t, s, "PUT", "/ai/keys/OPENAI", map[string]any{"key": "sk-secret-123456789"}, 200)
	queued := data(request(t, s, "POST", "/ai/generate", map[string]any{"ai": map[string]any{"provider": "OPENAI", "model": "test-model", "credentialMode": "BYOK", "effort": "LOW"}, "prompt": "제안", "applicationId": id(a), "evidenceIds": []string{}}, 202))
	if queued["status"] != "QUEUED" {
		t.Fatal(queued)
	}
	if e := s.ProcessOne(context.Background()); e != nil {
		t.Fatal(e)
	}
	op := data(request(t, s, "GET", "/operations/"+id(queued), nil, 200))
	if op["status"] != "SUCCEEDED" {
		t.Fatal(op)
	}
	value := op["result"].(map[string]any)["value"].(map[string]any)
	if value["text"] != "검토용 제안" || value["usage"].(map[string]any)["inputTokens"] != float64(20) {
		t.Fatal(value)
	}
}
func TestCancelledQueuedAIIsNeverDispatched(t *testing.T) {
	s := testApp(t)
	_, a := jobApp(t, s)
	s.Config.Models = []ModelConfig{{Provider: "OPENAI", Model: "test-model"}}
	request(t, s, "PUT", "/ai/keys/OPENAI", map[string]any{"key": "sk-secret-123456789"}, 200)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("cancelled request reached provider")
		http.Error(w, "must not dispatch", 500)
	}))
	defer provider.Close()
	s.HTTP = &http.Client{Transport: redirectTransport{target: provider.Listener.Addr().String()}}
	queued := data(request(t, s, "POST", "/ai/generate", map[string]any{"ai": map[string]any{"provider": "OPENAI", "model": "test-model", "credentialMode": "BYOK", "effort": "LOW"}, "prompt": "cancel this", "applicationId": id(a), "evidenceIds": []string{}}, 202))
	request(t, s, "POST", "/operations/"+id(queued)+"/cancel", map[string]any{}, 200)
	if e := s.ProcessOne(context.Background()); e != nil {
		t.Fatal(e)
	}
	op := data(request(t, s, "GET", "/operations/"+id(queued), nil, 200))
	if op["status"] != "CANCELLED" {
		t.Fatal("cancelled operation changed", op)
	}
}
func TestGeminiReceivesGroundingContext(t *testing.T) {
	s := testApp(t)
	received := ""
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Contents []struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"contents"`
		}
		if e := json.NewDecoder(r.Body).Decode(&payload); e != nil {
			t.Error(e)
		}
		received = payload.Contents[0].Parts[0].Text
		json.NewEncoder(w).Encode(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{map[string]any{"text": "Grounded answer"}}}}}, "usageMetadata": map[string]any{"promptTokenCount": 20, "candidatesTokenCount": 4}})
	}))
	defer provider.Close()
	s.HTTP = &http.Client{Transport: redirectTransport{target: provider.Listener.Addr().String()}}
	_, _, _, e := s.callAI(context.Background(), AIJob{AI: AiOptions{Provider: "GEMINI", Model: "test"}, UserPrompt: "Rewrite", Prompt: "Never invent experience.\nEVIDENCE: reduced latency by 20%\nRewrite", MaxOutput: 512}, "test-key")
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(received, "EVIDENCE: reduced latency by 20%") || !strings.Contains(received, "Never invent experience") {
		t.Fatalf("grounding context omitted: %q", received)
	}
}
