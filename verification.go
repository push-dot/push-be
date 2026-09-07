package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"github.com/labstack/echo/v4"
	"io"
	"net/http"
	"strings"
	"time"
)

func (s *Server) verifyProject(c echo.Context, v map[string]any, expected int) error {
	if s.Config.GitHubVerificationToken == "" || s.Config.GitHubWorkflowID == 0 {
		return fail(503, "NOT_CONFIGURED", "독립 GitHub CI 검증 토큰과 허용 workflow ID가 필요합니다")
	}
	if str(v, "status") != "PENDING" {
		return conflict("검증 대기 증빙이 아닙니다")
	}
	parts := strings.Split(str(v, "commitUrl"), "/")
	if len(parts) != 7 {
		return invalid("GitHub commit URL 오류")
	}
	base := "https://api.github.com/repos/" + parts[3] + "/" + parts[4]
	sha := str(v, "commitSha")
	headers := map[string]string{"Authorization": "Bearer " + s.Config.GitHubVerificationToken, "X-GitHub-Api-Version": "2022-11-28"}
	commit, e := s.providerRequest(c.Request().Context(), "GET", base+"/commits/"+sha, nil, headers)
	if e != nil {
		return e
	}
	if str(commit, "sha") != sha {
		return fail(422, "VERIFICATION_FAILED", "커밋 SHA가 일치하지 않습니다")
	}
	checks, e := s.providerRequest(c.Request().Context(), "GET", base+"/commits/"+sha+"/check-runs?per_page=100", nil, headers)
	if e != nil {
		return e
	}
	runs, _ := checks["check_runs"].([]any)
	success := false
	for _, raw := range runs {
		check, _ := raw.(map[string]any)
		if str(check, "head_sha") == sha && str(check, "status") == "completed" && str(check, "conclusion") == "success" {
			success = true
		}
		if str(check, "head_sha") == sha && oneOf(str(check, "conclusion"), "failure", "timed_out", "cancelled", "action_required") {
			return fail(422, "VERIFICATION_FAILED", "실패하거나 미완료된 CI 검사입니다")
		}
	}
	if !success {
		return fail(422, "VERIFICATION_FAILED", "해당 커밋의 성공 CI가 없습니다")
	}
	actions, e := s.providerRequest(c.Request().Context(), "GET", base+"/actions/runs?head_sha="+sha+"&status=success&per_page=100", nil, headers)
	if e != nil {
		return e
	}
	items, _ := actions["workflow_runs"].([]any)
	artifactURL := ""
	for _, raw := range items {
		run, _ := raw.(map[string]any)
		if number(run, "workflow_id") != s.Config.GitHubWorkflowID || str(run, "head_sha") != sha || str(run, "conclusion") != "success" {
			continue
		}
		artifacts, e := s.providerRequest(c.Request().Context(), "GET", base+"/actions/runs/"+jsonNumber(run["id"])+"/artifacts?per_page=100", nil, headers)
		if e != nil {
			return e
		}
		list, _ := artifacts["artifacts"].([]any)
		for _, x := range list {
			artifact, _ := x.(map[string]any)
			if str(artifact, "name") == "push-verification" && artifact["expired"] == false {
				artifactURL = base + "/actions/artifacts/" + jsonNumber(artifact["id"]) + "/zip"
				break
			}
		}
		if artifactURL != "" {
			break
		}
	}
	if artifactURL == "" {
		return fail(422, "VERIFICATION_FAILED", "허용된 workflow의 push-verification artifact가 없습니다")
	}
	req, e := http.NewRequestWithContext(c.Request().Context(), "GET", artifactURL, nil)
	if e != nil {
		return e
	}
	for k, value := range headers {
		req.Header.Set(k, value)
	}
	resp, e := s.HTTP.Do(req)
	if e != nil {
		return fail(502, "PROVIDER_ERROR", "CI artifact 다운로드 실패")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fail(502, "PROVIDER_ERROR", "CI artifact 접근 실패")
	}
	raw, e := io.ReadAll(io.LimitReader(resp.Body, 2<<20+1))
	if e != nil {
		return e
	}
	if len(raw) > 2<<20 {
		return fail(422, "VERIFICATION_FAILED", "CI artifact 크기 제한 초과")
	}
	archive, e := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if e != nil {
		return fail(422, "VERIFICATION_FAILED", "유효한 CI artifact ZIP이 아닙니다")
	}
	var report struct {
		Summary  string   `json:"summary"`
		Skills   []string `json:"skills"`
		SHA      string   `json:"commitSha"`
		Command  string   `json:"testCommand"`
		Output   string   `json:"testOutput"`
		ExitCode int      `json:"exitCode"`
		Metrics  []Metric `json:"metrics"`
	}
	found := false
	for _, file := range archive.File {
		if file.Name != "verification.json" {
			continue
		}
		if found || file.UncompressedSize64 > 1<<20 {
			return fail(422, "VERIFICATION_FAILED", "중복되거나 너무 큰 검증 보고서입니다")
		}
		found = true
		r, e := file.Open()
		if e != nil {
			return e
		}
		decoder := json.NewDecoder(io.LimitReader(r, 1<<20))
		decoder.DisallowUnknownFields()
		e = decoder.Decode(&report)
		r.Close()
		if e != nil {
			return fail(422, "VERIFICATION_FAILED", "CI 검증 보고서 형식 오류")
		}
	}
	test, _ := v["testResults"].(map[string]any)
	if !found || report.Summary != str(v, "summary") || report.SHA != sha || report.ExitCode != 0 || report.Command != str(test, "command") || report.Output != str(test, "output") || hashJSON(report.Metrics) != hashJSON(v["metrics"]) {
		return fail(422, "VERIFICATION_FAILED", "CI 실행 결과와 제출한 증빙이 다릅니다")
	}
	run, e := s.get(c, "runs", str(v, "runId"))
	if e != nil {
		return e
	}
	if str(run, "state") != "VERIFYING" || str(run, "commitSha") != sha {
		return fail(422, "VERIFICATION_FAILED", "로컬 실행과 원격 커밋이 다릅니다")
	}
	p, e := s.get(c, "projects", str(v, "projectId"))
	if e != nil {
		return e
	}
	for _, skill := range stringsAt(p, "skills") {
		found := false
		for _, actual := range report.Skills {
			if strings.EqualFold(skill, actual) {
				found = true
			}
		}
		if !found {
			return fail(422, "VERIFICATION_FAILED", "CI artifact에 해당 기술 검증이 없습니다")
		}
	}
	source := report.Summary + "\n\nCI command: " + report.Command + "\n" + report.Output + "\nMetrics: " + stringJSON(report.Metrics)
	career, e := s.create(c, "career-evidence", "", map[string]any{"kind": "PROJECT", "title": p["title"], "sourceText": source, "sourceUrl": v["commitUrl"], "skills": p["skills"], "verificationStatus": "VERIFIED", "archived": false, "provenance": map[string]any{"sourceId": nil, "projectEvidenceId": v["id"], "contentHash": hash(source)}})
	if e != nil {
		return e
	}
	v["status"] = "VERIFIED"
	v["verificationMethod"] = "GITHUB_CI_ARTIFACT"
	v["verifiedAt"] = time.Now().UTC()
	v["careerEvidenceId"] = career["id"]
	v, e = s.update(c, "project-evidence", v, expected)
	if e != nil {
		return e
	}
	run["state"] = "VERIFIED"
	if _, e = s.update(c, "runs", run, number(run, "revision")); e != nil {
		return e
	}
	p["state"] = "VERIFIED"
	if _, e = s.update(c, "projects", p, number(p, "revision")); e != nil {
		return e
	}
	return s.operation(c, "PROJECT_VERIFY", str(v, "applicationId"), v)
}
func jsonNumber(v any) string { raw, _ := json.Marshal(v); return string(raw) }
func stringJSON(v any) string { raw, _ := json.Marshal(v); return string(raw) }
