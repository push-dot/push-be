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
	r.Header.Set("Idempotency-Key", uuid.NewString())
	w := httptest.NewRecorder()
	s.Echo.ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("%s %s: want %d got %d %s", method, path, status, w.Code, w.Body.String())
	}
	if status == 204 {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}
func data(m map[string]any) map[string]any { return m["data"].(map[string]any) }
func id(m map[string]any) string           { return m["id"].(string) }
func approve(t *testing.T, s *Server, kind, app, target string) string {
	a := data(request(t, s, "POST", "/approvals", map[string]any{"kind": kind, "applicationId": app, "targetId": target}, 201))
	request(t, s, "POST", "/approvals/"+id(a)+"/decision", map[string]any{"expectedRevision": 1, "decision": "APPROVED"}, 200)
	return id(a)
}
func jobApp(t *testing.T, s *Server) (map[string]any, map[string]any) {
	j := data(request(t, s, "POST", "/jobs", map[string]any{"company": "테스트 회사", "title": "개발자", "sourceText": "Go PostgreSQL 개발", "sourceKind": "TEXT", "requirements": []string{"Go", "PostgreSQL"}, "preferred": []string{"Redis"}}, 201))
	a := data(request(t, s, "POST", "/applications", map[string]any{"jobId": id(j)}, 201))
	return j, a
}
func opResult(t *testing.T, m map[string]any) any {
	t.Helper()
	o := data(m)
	if o["status"] != "SUCCEEDED" {
		t.Fatalf("operation unfinished: %v", o)
	}
	return o["result"].(map[string]any)["value"]
}
func versionInput(eid, text string) map[string]any {
	return map[string]any{"expectedRevision": 1, "content": map[string]any{"type": "doc", "content": []any{map[string]any{"type": "paragraph", "attrs": map[string]any{"blockId": "b1"}, "content": []any{map[string]any{"type": "text", "text": text}}}}}, "blocks": []any{map[string]any{"id": "b1", "text": text, "evidenceRefs": []any{map[string]any{"evidenceId": eid, "start": 0, "end": len([]rune("Go API 응답 시간을 20% 줄였습니다."))}}}}}
}
func TestContractGroundedDocumentSubmissionAndIsolation(t *testing.T) {
	s := testApp(t)
	j, a := jobApp(t, s)
	_, b := jobApp(t, s)
	e := data(request(t, s, "POST", "/career-evidence", map[string]any{"kind": "CAREER", "title": "API", "sourceText": "Go API 응답 시간을 20% 줄였습니다.", "skills": []string{"Go"}}, 201))
	approve(t, s, "EVIDENCE_USE", id(a), id(e))
	analysis := opResult(t, request(t, s, "POST", "/jobs/"+id(j)+"/analyze", map[string]any{"applicationId": id(a), "expectedRevision": 1, "evidenceIds": []string{id(e)}, "ai": nil}, 202)).(map[string]any)
	if analysis["fitScore"] != float64(50) {
		t.Fatal(analysis)
	}
	d := data(request(t, s, "POST", "/documents", map[string]any{"applicationId": id(a), "title": "doc", "kind": "RESUME", "template": "CLASSIC"}, 201))
	v := data(request(t, s, "POST", "/documents/"+id(d)+"/versions", versionInput(id(e), "Go API 응답 시간을 90% 줄였습니다."), 201))["version"].(map[string]any)
	approval := approve(t, s, "DOCUMENT_FINALIZE", id(a), id(v))
	request(t, s, "POST", "/documents/"+id(d)+"/finalize", map[string]any{"expectedRevision": 2, "versionId": id(v), "approvalId": approval}, 409)
	generated := opResult(t, request(t, s, "POST", "/documents/"+id(d)+"/generate", map[string]any{"expectedRevision": 2, "evidenceIds": []string{id(e)}, "ai": nil}, 202)).(map[string]any)
	v2 := generated["version"].(map[string]any)
	approval = approve(t, s, "DOCUMENT_FINALIZE", id(a), id(v2))
	request(t, s, "POST", "/documents/"+id(d)+"/finalize", map[string]any{"expectedRevision": 3, "versionId": id(v2), "approvalId": approval}, 200)
	request(t, s, "PATCH", "/applications/"+id(a), map[string]any{"expectedRevision": 1, "stage": "PREPARING"}, 200)
	request(t, s, "PATCH", "/applications/"+id(a), map[string]any{"expectedRevision": 2, "stage": "READY"}, 200)
	request(t, s, "PATCH", "/applications/"+id(a), map[string]any{"expectedRevision": 3, "stage": "APPLIED"}, 409)
	draft := data(request(t, s, "POST", "/applications/"+id(a)+"/submission-drafts", map[string]any{"expectedRevision": 3, "mode": "MANUAL_RECORD", "documentVersionIds": []string{id(v2)}, "confirmedSubmitted": true}, 201))
	approval = approve(t, s, "APPLICATION_SUBMIT", id(a), id(draft))
	request(t, s, "POST", "/applications/"+id(a)+"/submissions", map[string]any{"expectedRevision": 3, "draftId": id(draft), "approvalId": approval}, 201)
	request(t, s, "POST", "/applications/"+id(a)+"/submissions", map[string]any{"expectedRevision": 3, "draftId": id(draft), "approvalId": approval}, 409)
	docs := request(t, s, "GET", "/documents?applicationId="+id(b), nil, 200)
	if len(docs["data"].([]any)) != 0 {
		t.Fatal("scope leak")
	}
	if docs["page"] == nil {
		t.Fatal("pagination envelope missing")
	}
	_, err := s.DB.Exec(context.Background(), "UPDATE resources SET owner_id=$1 WHERE id=$2", uuid.NewString(), id(j))
	if err != nil {
		t.Fatal(err)
	}
	request(t, s, "GET", "/jobs/"+id(j), nil, 404)
}
func TestTipTapUnlinkedTextAndClientClaimStatusRejected(t *testing.T) {
	s := testApp(t)
	_, a := jobApp(t, s)
	e := data(request(t, s, "POST", "/career-evidence", map[string]any{"kind": "CAREER", "title": "API", "sourceText": "Go API 응답 시간을 20% 줄였습니다.", "skills": []string{"Go"}}, 201))
	d := data(request(t, s, "POST", "/documents", map[string]any{"applicationId": id(a), "title": "doc", "kind": "RESUME", "template": "CLASSIC"}, 201))
	body := versionInput(id(e), "Go API 응답 시간을 20% 줄였습니다.")
	body["blocks"].([]any)[0].(map[string]any)["claimStatus"] = "SUPPORTED"
	request(t, s, "POST", "/documents/"+id(d)+"/versions", body, 400)
	delete(body["blocks"].([]any)[0].(map[string]any), "claimStatus")
	body["content"].(map[string]any)["content"].([]any)[0].(map[string]any)["content"].([]any)[0].(map[string]any)["text"] = "숨겨진 수치 90%"
	request(t, s, "POST", "/documents/"+id(d)+"/versions", body, 400)
}
func TestIdempotencyAndScopedApproval(t *testing.T) {
	s := testApp(t)
	_, a := jobApp(t, s)
	_, b := jobApp(t, s)
	e := data(request(t, s, "POST", "/career-evidence", map[string]any{"kind": "CAREER", "title": "API", "sourceText": "Go", "skills": []string{"Go"}}, 201))
	approve(t, s, "EVIDENCE_USE", id(a), id(e))
	d := data(request(t, s, "POST", "/documents", map[string]any{"applicationId": id(b), "title": "doc", "kind": "RESUME", "template": "CLASSIC"}, 201))
	request(t, s, "POST", "/documents/"+id(d)+"/generate", map[string]any{"expectedRevision": 1, "evidenceIds": []string{id(e)}, "ai": nil}, 409)
	key := uuid.NewString()
	send := func(title string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/v1/career-evidence", strings.NewReader(`{"kind":"SKILL","title":"`+title+`","sourceText":"Go","skills":["Go"]}`))
		r.Header.Set("Authorization", "Bearer test-secret")
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", key)
		w := httptest.NewRecorder()
		s.Echo.ServeHTTP(w, r)
		return w
	}
	first, second := send("Go"), send("Go")
	if first.Code != 201 || second.Code != 201 {
		t.Fatal(first.Body, second.Body)
	}
	var f, g map[string]any
	json.Unmarshal(first.Body.Bytes(), &f)
	json.Unmarshal(second.Body.Bytes(), &g)
	if id(data(f)) != id(data(g)) {
		t.Fatal("duplicate create")
	}
	if send("Rust").Code != 409 {
		t.Fatal("key body mismatch accepted")
	}
}
func TestAESKeysNeverReturned(t *testing.T) {
	s := testApp(t)
	request(t, s, "PUT", "/ai/keys/OPENAI", map[string]any{"key": "sk-secret-123456789"}, 200)
	out := request(t, s, "GET", "/ai/keys", nil, 200)
	b, _ := json.Marshal(out)
	if bytes.Contains(b, []byte("sk-secret")) {
		t.Fatal("secret leaked")
	}
	var encrypted []byte
	s.DB.QueryRow(context.Background(), "SELECT ciphertext FROM ai_keys").Scan(&encrypted)
	if bytes.Contains(encrypted, []byte("sk-secret")) {
		t.Fatal("plaintext stored")
	}
	encrypted[len(encrypted)-1] ^= 1
	if _, e := s.decrypt(encrypted, "wrong-owner:OPENAI"); e == nil {
		t.Fatal("tamper accepted")
	}
}
func TestCalendarInterviewOfferAndRoutineContract(t *testing.T) {
	s := testApp(t)
	_, a := jobApp(t, s)
	event := data(request(t, s, "POST", "/calendar/events", map[string]any{"applicationId": id(a), "type": "CUSTOM", "title": "일정", "startsAt": "2026-10-01T01:00:00Z", "endsAt": "2026-10-01T02:00:00Z", "timeZone": "Asia/Seoul"}, 201))
	request(t, s, "PATCH", "/calendar/events/"+id(event), map[string]any{"expectedRevision": 1, "endsAt": "2026-10-01T00:00:00Z"}, 400)
	interview := data(request(t, s, "POST", "/interviews", map[string]any{"applicationId": id(a), "title": "면접", "scheduledAt": "2026-10-02T01:00:00Z", "evidenceIds": []string{}}, 201))
	if interview["eventId"] == nil {
		t.Fatal("missing linked calendar event")
	}
	opResult(t, request(t, s, "POST", "/interviews/"+id(interview)+"/prepare", map[string]any{"expectedRevision": 1, "ai": nil}, 202))
	x := data(request(t, s, "POST", "/offers", map[string]any{"applicationId": id(a), "company": "A", "annualSalaryMinor": 70000000, "currency": "KRW"}, 201))
	y := data(request(t, s, "POST", "/offers", map[string]any{"applicationId": id(a), "company": "B", "annualSalaryMinor": 10000000, "currency": "USD"}, 201))
	cmp := data(request(t, s, "GET", "/offers/compare?ids="+id(x)+","+id(y), nil, 200))
	if cmp["comparison"].(map[string]any)["sameCurrency"] != false {
		t.Fatal("currency conflation")
	}
	r := data(request(t, s, "POST", "/routines", map[string]any{"applicationId": id(a), "title": "확인", "kind": "FOLLOW_UP", "dueAt": "2026-10-03T01:00:00Z"}, 201))
	if r["status"] != "SUGGESTED" {
		t.Fatal(r)
	}
	request(t, s, "PATCH", "/routines/"+id(r), map[string]any{"expectedRevision": 1, "status": "DONE"}, 409)
	request(t, s, "PATCH", "/routines/"+id(r), map[string]any{"expectedRevision": 1, "status": "CONFIRMED"}, 200)
	conv := data(request(t, s, "POST", "/conversations", map[string]any{"applicationId": id(a), "title": "지원 대화"}, 201))
	request(t, s, "PATCH", "/conversations/"+id(conv), map[string]any{"expectedRevision": 1, "pinned": true}, 200)
}
func TestSyncMutationAtomicIdempotentAndRestricted(t *testing.T) {
	s := testApp(t)
	_, a := jobApp(t, s)
	client, mutation := uuid.NewString(), uuid.NewString()
	body := map[string]any{"clientId": client, "mutations": []any{map[string]any{"mutationId": mutation, "resourceType": "APPLICATION", "resourceId": id(a), "expectedRevision": 1, "action": "UPDATE_NOTES", "payload": map[string]any{"notes": "오프라인 메모"}}}}
	result := data(request(t, s, "POST", "/sync/mutations", body, 200))
	if result["results"].([]any)[0].(map[string]any)["status"] != "APPLIED" {
		t.Fatal(result)
	}
	request(t, s, "POST", "/sync/mutations", body, 200)
	current := data(request(t, s, "GET", "/applications/"+id(a), nil, 200))
	if current["revision"] != float64(2) || current["notes"] != "오프라인 메모" {
		t.Fatal(current)
	}
	body["mutations"].([]any)[0].(map[string]any)["mutationId"] = uuid.NewString()
	body["mutations"].([]any)[0].(map[string]any)["action"] = "SUBMIT"
	rejected := data(request(t, s, "POST", "/sync/mutations", body, 200))
	if rejected["results"].([]any)[0].(map[string]any)["status"] != "REJECTED" {
		t.Fatal("offline submit allowed")
	}
}
func TestCommitFailureNeverSendsSuccess(t *testing.T) {
	s := testApp(t)
	_, e := s.DB.Exec(context.Background(), `CREATE FUNCTION reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced commit failure'; END $$; CREATE CONSTRAINT TRIGGER force_commit_failure AFTER INSERT ON resources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.body->>'title'='COMMIT_FAIL') EXECUTE FUNCTION reject_commit();`)
	if e != nil {
		t.Fatal(e)
	}
	request(t, s, "POST", "/career-evidence", map[string]any{"kind": "SKILL", "title": "COMMIT_FAIL", "sourceText": "Go", "skills": []string{"Go"}}, 500)
	var count int
	s.DB.QueryRow(context.Background(), "SELECT count(*) FROM resources").Scan(&count)
	if count != 0 {
		t.Fatal("failed commit leaked records")
	}
}
func TestCORSAllowsMutationHeaders(t *testing.T) {
	s := testApp(t)
	r := httptest.NewRequest("OPTIONS", "/api/v1/jobs", nil)
	r.Header.Set("Origin", "http://localhost:5173")
	r.Header.Set("Access-Control-Request-Method", "POST")
	r.Header.Set("Access-Control-Request-Headers", "authorization,content-type,idempotency-key,if-match,last-event-id")
	w := httptest.NewRecorder()
	s.Echo.ServeHTTP(w, r)
	if w.Code != 204 || !strings.Contains(strings.ToLower(w.Header().Get("Access-Control-Allow-Headers")), "idempotency-key") {
		t.Fatal("mutation preflight blocked", w.Header())
	}
}
