package main

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func testApp(t *testing.T) *Server {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to a real PostgreSQL database")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := "test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	root, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = root.Exec(context.Background(), "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	db, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close(); root.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE"); root.Close() })
	app, err := NewServer(db, Config{Environment: "development", DevToken: "test-secret", AESKey: bytes.Repeat([]byte{7}, 32)})
	if err != nil {
		t.Fatal(err)
	}
	return app
}
func request(t *testing.T, s *Server, method, path string, body any, status int) map[string]any {
	t.Helper()
	b, _ := json.Marshal(body)
	r := httptest.NewRequest(method, "/api/v1"+path, bytes.NewReader(b))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer test-secret")
	w := httptest.NewRecorder()
	s.Echo.ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("%s %s: want %d got %d %s", method, path, status, w.Code, w.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}
func data(m map[string]any) map[string]any { return m["data"].(map[string]any) }
func id(m map[string]any) string           { return m["id"].(string) }
func approve(t *testing.T, s *Server, kind, target string) {
	a := data(request(t, s, "POST", "/approvals", map[string]any{"kind": kind, "targetId": target}, 201))
	request(t, s, "POST", "/approvals/"+id(a)+"/decision", map[string]any{"decision": "APPROVED"}, 200)
}
func jobApp(t *testing.T, s *Server) (map[string]any, map[string]any) {
	j := data(request(t, s, "POST", "/jobs", map[string]any{"company": "테스트 회사", "title": "개발자", "sourceText": "Go PostgreSQL 개발", "sourceKind": "TEXT", "requirements": []string{"Go", "PostgreSQL"}, "preferred": []string{"Redis"}}, 201))
	a := data(request(t, s, "POST", "/applications", map[string]any{"jobId": id(j)}, 201))
	return j, a
}

func TestGroundedVersionsAndApplicationIsolation(t *testing.T) {
	s := testApp(t)
	j, a := jobApp(t, s)
	_, b := jobApp(t, s)
	e := data(request(t, s, "POST", "/career-evidence", map[string]any{"kind": "CAREER", "title": "API 개발", "sourceText": "Go API 응답 시간을 20% 줄였습니다.", "skills": []string{"Go"}}, 201))
	analysis := data(request(t, s, "POST", "/jobs/"+id(j)+"/analyze", map[string]any{}, 200))
	if analysis["fitScore"] != float64(50) {
		t.Fatalf("actual evidence match score: %v", analysis)
	}
	doc := data(request(t, s, "POST", "/documents", map[string]any{"applicationId": id(a), "title": "지원 서류", "kind": "RESUME", "template": "CLASSIC"}, 201))
	v := data(request(t, s, "POST", "/documents/"+id(doc)+"/versions", map[string]any{"expectedRevision": 1, "blocks": []any{map[string]any{"text": "Go API 응답 시간을 90% 줄였습니다.", "evidenceIds": []string{id(e)}}}}, 201))
	approve(t, s, "EVIDENCE_USE", id(e))
	approve(t, s, "DOCUMENT_FINALIZE", id(v))
	request(t, s, "POST", "/documents/"+id(doc)+"/finalize", map[string]any{"expectedRevision": 2, "versionId": id(v)}, 409)
	v2 := data(request(t, s, "POST", "/documents/"+id(doc)+"/generate", map[string]any{"expectedRevision": 2, "evidenceIds": []string{id(e)}}, 201))
	approve(t, s, "DOCUMENT_FINALIZE", id(v2))
	request(t, s, "POST", "/documents/"+id(doc)+"/finalize", map[string]any{"expectedRevision": 3, "versionId": id(v2)}, 200)
	request(t, s, "POST", "/documents/"+id(doc)+"/generate", map[string]any{"expectedRevision": 3, "evidenceIds": []string{id(e)}}, 409)
	docs := request(t, s, "GET", "/documents?applicationId="+id(b), nil, 200)["data"].([]any)
	if len(docs) != 0 {
		t.Fatal("applications leaked documents")
	}
	_, err := s.DB.Exec(context.Background(), "UPDATE resources SET owner_id=$1 WHERE id=$2", uuid.NewString(), id(j))
	if err != nil {
		t.Fatal(err)
	}
	request(t, s, "GET", "/jobs/"+id(j), nil, 404)
}
func TestApplicationApprovalAndTerminalStates(t *testing.T) {
	s := testApp(t)
	_, a := jobApp(t, s)
	p := "/applications/" + id(a)
	request(t, s, "PATCH", p, map[string]any{"expectedRevision": 1, "stage": "APPLIED"}, 409)
	request(t, s, "PATCH", p, map[string]any{"expectedRevision": 1, "stage": "PREPARING"}, 200)
	request(t, s, "PATCH", p, map[string]any{"expectedRevision": 2, "stage": "READY"}, 200)
	request(t, s, "PATCH", p, map[string]any{"expectedRevision": 3, "stage": "APPLIED"}, 409)
	approve(t, s, "APPLICATION_SUBMIT", id(a))
	request(t, s, "PATCH", p, map[string]any{"expectedRevision": 3, "stage": "APPLIED"}, 200)
	request(t, s, "PATCH", p, map[string]any{"expectedRevision": 4, "stage": "WITHDRAWN"}, 200)
	request(t, s, "PATCH", p, map[string]any{"expectedRevision": 5, "stage": "PREPARING"}, 409)
}
func TestStrictInputAndNoImplicitAuthentication(t *testing.T) {
	s := testApp(t)
	request(t, s, "POST", "/career-evidence", map[string]any{"kind": "CAREER", "title": "title", "sourceText": "text", "ownerId": uuid.NewString()}, 400)
	r := httptest.NewRequest("GET", "/api/v1/jobs", nil)
	w := httptest.NewRecorder()
	s.Echo.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("missing auth accepted")
	}
	request(t, s, "POST", "/approvals", map[string]any{"kind": "CLI_EXECUTE", "targetId": uuid.NewString()}, 404)
	request(t, s, "POST", "/integrations/google/sync", map[string]any{}, 403)
	request(t, s, "POST", "/billing/checkout", map[string]any{}, 503)
}
func TestProjectEvidenceRequiresApprovalAndSuccessfulVerification(t *testing.T) {
	s := testApp(t)
	_, a := jobApp(t, s)
	ps := request(t, s, "POST", "/projects/blueprints", map[string]any{"applicationId": id(a)}, 201)["data"].([]any)
	if len(ps) != 4 {
		t.Fatal("need four practical projects")
	}
	p := ps[0].(map[string]any)
	run := data(request(t, s, "POST", "/projects/"+id(p)+"/runs", map[string]any{"provider": "CODEX", "workingDirectory": "/tmp/project", "prompt": "Build this project"}, 201))
	path := "/projects/" + id(p) + "/runs/" + id(run)
	request(t, s, "PATCH", path, map[string]any{"expectedRevision": 1, "state": "RUNNING"}, 409)
	approve(t, s, "CLI_EXECUTE", id(run))
	request(t, s, "PATCH", path, map[string]any{"expectedRevision": 1, "state": "RUNNING"}, 200)
	request(t, s, "PATCH", path, map[string]any{"expectedRevision": 2, "state": "VERIFYING"}, 200)
	evidence := map[string]any{"runId": id(run), "commitUrl": "https://github.com/push-dot/test/commit/" + strings.Repeat("a", 40), "testCommand": "go test ./...", "testOutput": "FAIL", "exitCode": 1, "metrics": []any{map[string]any{"name": "p95", "value": 20, "unit": "ms"}}, "summary": "API measured"}
	request(t, s, "POST", "/projects/"+id(p)+"/evidence", evidence, 400)
	evidence["exitCode"] = 0
	evidence["testOutput"] = "ok test"
	result := data(request(t, s, "POST", "/projects/"+id(p)+"/evidence", evidence, 201))
	if result["verificationMethod"] != "USER_ATTESTED" {
		t.Fatal("must not pretend remote verification")
	}
}
func TestAESKeysAreAuthenticatedAndNeverReturned(t *testing.T) {
	s := testApp(t)
	request(t, s, "PUT", "/ai/keys/OPENAI", map[string]any{"key": "sk-secret-123456789"}, 200)
	keys := request(t, s, "GET", "/ai/keys", nil, 200)
	encoded, _ := json.Marshal(keys)
	if bytes.Contains(encoded, []byte("sk-secret")) {
		t.Fatal("key leaked")
	}
	var stored []byte
	if err := s.DB.QueryRow(context.Background(), "SELECT ciphertext FROM ai_keys").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, []byte("sk-secret")) {
		t.Fatal("plaintext persisted")
	}
	stored[len(stored)-1] ^= 1
	if _, err := s.decrypt(stored, "wrong-owner:OPENAI"); err == nil {
		t.Fatal("tampered secret accepted")
	}
}

func TestInterviewOfferRoutineLifecycle(t *testing.T) {
	s := testApp(t)
	_, a := jobApp(t, s)
	e := data(request(t, s, "POST", "/career-evidence", map[string]any{"kind": "CAREER", "title": "경험", "sourceText": "Go API를 개발했습니다.", "skills": []string{"Go"}}, 201))
	in := data(request(t, s, "POST", "/interviews", map[string]any{"applicationId": id(a), "title": "기술 면접", "scheduledAt": "2026-10-01T09:00:00Z", "evidenceIds": []string{id(e)}}, 201))
	prepared := data(request(t, s, "POST", "/interviews/"+id(in)+"/prepare", map[string]any{}, 200))
	answer := prepared["starAnswers"].([]any)[0].(map[string]any)
	if answer["action"] != "Go API를 개발했습니다." || answer["result"] != "" {
		t.Fatal("interview invented experience")
	}
	request(t, s, "PATCH", "/interviews/"+id(in), map[string]any{"expectedRevision": 1, "notes": "질문 기록", "reflection": "동시성 복습"}, 200)
	offer := data(request(t, s, "POST", "/offers", map[string]any{"applicationId": id(a), "company": "Company", "annualSalary": 70000000, "currency": "KRW"}, 201))
	if offer["annualSalary"] != float64(70000000) {
		t.Fatal("salary lost")
	}
	request(t, s, "POST", "/offers", map[string]any{"applicationId": id(a), "company": "Company", "annualSalary": -1, "currency": "KRW"}, 400)
	routine := data(request(t, s, "POST", "/routines", map[string]any{"applicationId": id(a), "title": "회고 확인", "kind": "INTERVIEW_PREP", "dueAt": "2026-10-01T08:00:00Z"}, 201))
	path := "/routines/" + id(routine)
	request(t, s, "PATCH", path, map[string]any{"expectedRevision": 1, "status": "DONE"}, 409)
	request(t, s, "PATCH", path, map[string]any{"expectedRevision": 1, "status": "CONFIRMED"}, 200)
	request(t, s, "PATCH", path, map[string]any{"expectedRevision": 2, "status": "DONE"}, 200)
}
func TestFailedVersionWriteRollsBack(t *testing.T) {
	s := testApp(t)
	_, a := jobApp(t, s)
	d := data(request(t, s, "POST", "/documents", map[string]any{"applicationId": id(a), "title": "doc", "kind": "RESUME", "template": "CLASSIC"}, 201))
	request(t, s, "POST", "/documents/"+id(d)+"/versions", map[string]any{"expectedRevision": 1, "blocks": []any{map[string]any{"text": "fake", "evidenceIds": []string{uuid.NewString()}}}}, 404)
	versions := request(t, s, "GET", "/documents/"+id(d)+"/versions", nil, 200)["data"].([]any)
	if len(versions) != 0 {
		t.Fatal("failed version persisted")
	}
	current := data(request(t, s, "GET", "/documents/"+id(d), nil, 200))
	if current["revision"] != float64(1) {
		t.Fatal("revision changed on failure")
	}
}
