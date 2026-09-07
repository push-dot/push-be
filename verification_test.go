package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCLILaunchReplayAndIndependentArtifactVerification(t *testing.T) {
	s := testApp(t)
	j, a := jobApp(t, s)
	analysis := opResult(t, request(t, s, "POST", "/jobs/"+id(j)+"/analyze", map[string]any{"applicationId": id(a), "expectedRevision": 1, "evidenceIds": []string{}, "ai": nil}, 202)).(map[string]any)
	projects := opResult(t, request(t, s, "POST", "/projects/blueprints", map[string]any{"applicationId": id(a), "gapAnalysisId": id(analysis), "ai": nil}, 202)).([]any)
	p := projects[0].(map[string]any)
	request(t, s, "POST", "/projects/"+id(p)+"/select", map[string]any{"expectedRevision": 1}, 200)
	r := data(request(t, s, "POST", "/projects/"+id(p)+"/runs", map[string]any{"provider": "CODEX", "workingDirectory": "/tmp/push-project", "prompt": "Build"}, 201))
	approval := approve(t, s, "CLI_EXECUTE", id(a), id(r))
	device := "00000000-0000-4000-8000-000000000777"
	path := "/projects/" + id(p) + "/runs/" + id(r)
	request(t, s, "POST", path+"/start", map[string]any{"expectedRevision": 1, "approvalId": approval, "detectedVersion": "1.0", "deviceId": device}, 200)
	request(t, s, "POST", path+"/launch", map[string]any{"expectedRevision": 2, "deviceId": device, "payloadHash": r["payloadHash"], "launchStatus": "CLAIMED"}, 200)
	request(t, s, "POST", path+"/launch", map[string]any{"expectedRevision": 3, "deviceId": device, "payloadHash": r["payloadHash"], "launchStatus": "CLAIMED"}, 409)
	request(t, s, "POST", path+"/launch", map[string]any{"expectedRevision": 3, "deviceId": device, "payloadHash": r["payloadHash"], "launchStatus": "STARTED", "process": map[string]any{"pid": 123, "startedAt": "2026-09-07T09:00:00Z"}}, 200)
	sha := strings.Repeat("a", 40)
	request(t, s, "POST", path+"/result", map[string]any{"expectedRevision": 4, "exitCode": 0, "commitSha": sha, "stdoutHash": strings.Repeat("b", 64), "stderrHash": strings.Repeat("c", 64)}, 200)
	metrics := []any{map[string]any{"name": "latency", "value": 20, "unit": "ms"}}
	ev := data(request(t, s, "POST", "/projects/"+id(p)+"/evidence", map[string]any{"runId": id(r), "commitUrl": "https://github.com/push-dot/proof/commit/" + sha, "testCommand": "go test ./...", "testOutput": "ok proof", "exitCode": 0, "metrics": metrics, "summary": "Measured search"}, 201))
	verifyPath := "/projects/" + id(p) + "/evidence/" + id(ev) + "/verify"
	request(t, s, "POST", verifyPath, map[string]any{"expectedRevision": 1}, 503)
	s.Config.GitHubVerificationToken = "github-test"
	s.Config.GitHubWorkflowID = 9
	var archive bytes.Buffer
	z := zip.NewWriter(&archive)
	file, _ := z.Create("verification.json")
	json.NewEncoder(file).Encode(map[string]any{"summary": "Measured search", "skills": []string{"Go", "PostgreSQL"}, "commitSha": sha, "testCommand": "go test ./...", "testOutput": "ok proof", "exitCode": 0, "metrics": metrics})
	z.Close()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload any
		switch {
		case strings.HasSuffix(r.URL.Path, "/zip"):
			w.Write(archive.Bytes())
			return
		case strings.HasSuffix(r.URL.Path, "/check-runs"):
			payload = map[string]any{"check_runs": []any{map[string]any{"head_sha": sha, "status": "completed", "conclusion": "success"}}}
		case strings.HasSuffix(r.URL.Path, "/actions/runs"):
			payload = map[string]any{"workflow_runs": []any{map[string]any{"id": 11, "workflow_id": 9, "head_sha": sha, "conclusion": "success"}}}
		case strings.HasSuffix(r.URL.Path, "/artifacts"):
			payload = map[string]any{"artifacts": []any{map[string]any{"id": 12, "name": "push-verification", "expired": false}}}
		default:
			payload = map[string]any{"sha": sha}
		}
		json.NewEncoder(w).Encode(payload)
	}))
	defer provider.Close()
	s.HTTP = &http.Client{Transport: redirectTransport{target: provider.Listener.Addr().String()}}
	verified := opResult(t, request(t, s, "POST", verifyPath, map[string]any{"expectedRevision": 1}, 202)).(map[string]any)
	if verified["status"] != "VERIFIED" || verified["careerEvidenceId"] == nil {
		t.Fatal(verified)
	}
}
