package main

import (
	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"path/filepath"
	"strings"
	"time"
)

func (s *Server) contractProjects(g *echo.Group) {
	g.POST("/projects/blueprints", func(c echo.Context) error {
		var in struct {
			ApplicationID string     `json:"applicationId"`
			AnalysisID    string     `json:"gapAnalysisId"`
			AI            *AiOptions `json:"ai"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		a, e := s.get(c, "applications", in.ApplicationID)
		if e != nil {
			return e
		}
		analysis, e := s.get(c, "analyses", in.AnalysisID)
		if e != nil {
			return e
		}
		if str(analysis, "applicationId") != in.ApplicationID {
			return invalid("다른 지원 분석입니다")
		}
		if in.AI != nil {
			return s.aiUnavailable(c, in.AI)
		}
		j, e := s.get(c, "jobs", str(a, "jobId"))
		if e != nil {
			return e
		}
		skills := stringsAt(j, "requirements")
		if len(skills) == 0 {
			return invalid("공고 요구 기술을 입력하세요")
		}
		out := []any{}
		themes := []struct{ title, problem, solution, metric, unit string }{
			{"근거 검색", "많은 원문에서 필요한 근거를 찾기 어렵습니다", "검색 색인과 필터를 구현하고 정답 데이터로 정확도를 측정합니다", "검색 p95", "ms"},
			{"예약 동시성", "동시 요청이 중복 예약을 만듭니다", "원자적 저장소 제약과 충돌 응답으로 예약 무결성을 보장합니다", "중복 예약", "count"},
			{"편집 충돌 복구", "여러 기기의 저장이 이전 편집을 덮어씁니다", "불변 버전과 조건부 저장 및 병합 화면을 구현합니다", "소실 편집", "count"},
			{"멱등 작업 처리", "실패 후 재시도가 중복 부작용을 만듭니다", "멱등 키와 영속 실행 기록을 이용해 재시도를 검증합니다", "중복 실행", "count"},
		}
		for _, t := range themes {
			tasks := []any{}
			for _, title := range []string{"데이터 모델과 실패 조건 정의", "공고 기술로 핵심 기능 구현", "입력·오류·동시성 테스트", "변경 전후 지표 측정"} {
				tasks = append(tasks, map[string]any{"id": uuid.NewString(), "title": title, "description": t.solution, "acceptance": []string{"실행 명령과 관측 결과를 커밋에 기록"}})
			}
			v, e := s.create(c, "projects", in.ApplicationID, map[string]any{"applicationId": in.ApplicationID, "gapAnalysisId": in.AnalysisID, "title": str(j, "company") + " · " + t.title, "skills": skills, "problem": t.problem, "solution": t.solution, "tasks": tasks, "completionCriteria": []string{"핵심 사용자 흐름 실행", "실패·동시성 테스트 통과", "CI에 테스트와 측정 artifact 보관"}, "metrics": []any{map[string]any{"name": t.metric, "unit": t.unit, "measurement": "동일 데이터와 반복 횟수에서 변경 전후 측정", "target": nil}}, "estimatedEffort": map[string]int{"minHours": 8, "maxHours": 24}, "state": "DRAFT"})
			if e != nil {
				return e
			}
			out = append(out, v)
		}
		return s.operation(c, "PROJECT_BLUEPRINTS", in.ApplicationID, out)
	})
	g.POST("/projects/:id/select", func(c echo.Context) error {
		var in struct {
			Expected int `json:"expectedRevision"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		p, e := s.get(c, "projects", c.Param("id"))
		if e != nil {
			return e
		}
		if e = s.checkRevision(c, p, in.Expected); e != nil {
			return e
		}
		if str(p, "state") != "DRAFT" {
			return conflict("이미 선택한 프로젝트입니다")
		}
		p["state"] = "SELECTED"
		p, e = s.update(c, "projects", p, in.Expected)
		if e != nil {
			return e
		}
		content := "# " + str(p, "title") + "\n\n" + str(p, "problem") + "\n\n" + str(p, "solution") + "\n\n## 완료 기준\n"
		for _, criterion := range stringsAt(p, "completionCriteria") {
			content += "- " + criterion + "\n"
		}
		manifest := map[string]any{"projectId": p["id"], "blueprintRevision": p["revision"], "files": []any{map[string]string{"path": "README.md", "encoding": "utf8", "content": content, "sha256": hash(content)}}}
		return ok(c, 200, map[string]any{"blueprint": p, "manifest": manifest})
	})
	for _, kind := range []string{"runs", "project-evidence"} {
		k := kind
		path := "runs"
		if k == "project-evidence" {
			path = "evidence"
		}
		g.GET("/projects/:id/"+path, func(c echo.Context) error {
			p, e := s.get(c, "projects", c.Param("id"))
			if e != nil {
				return e
			}
			v, e := s.list(c, k, str(p, "applicationId"))
			if e != nil {
				return e
			}
			return page(c, filter(v, "projectId", c.Param("id")))
		})
	}
	g.POST("/projects/:id/runs", func(c echo.Context) error {
		var in struct {
			Provider  string `json:"provider"`
			Directory string `json:"workingDirectory"`
			Prompt    string `json:"prompt"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		executable := map[string]string{"CODEX": "codex", "CLAUDE_CODE": "claude", "GROK_BUILD": "grok"}[in.Provider]
		if executable == "" || !filepath.IsAbs(in.Directory) || filepath.Clean(in.Directory) != in.Directory || strings.ContainsAny(in.Directory, "\x00\n\r") || !length(in.Prompt, 1, 100000) {
			return invalid("CLI·폴더·프롬프트 오류")
		}
		p, e := s.get(c, "projects", c.Param("id"))
		if e != nil {
			return e
		}
		if !oneOf(str(p, "state"), "SELECTED", "IN_PROGRESS") {
			return conflict("먼저 프로젝트를 선택하세요")
		}
		args := []string{in.Prompt}
		m := map[string]any{"projectId": p["id"], "applicationId": p["applicationId"], "provider": in.Provider, "workingDirectory": in.Directory, "executable": executable, "arguments": args, "prompt": in.Prompt, "state": "APPROVAL_REQUIRED", "approvalId": nil, "startedAt": nil, "finishedAt": nil, "failureReason": nil, "launchStatus": "NOT_CLAIMED", "deviceId": nil, "process": nil}
		m["payloadHash"] = hashJSON(map[string]any{"executable": executable, "arguments": args, "workingDirectory": in.Directory, "prompt": in.Prompt})
		v, e := s.create(c, "runs", str(p, "applicationId"), m)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.POST("/projects/:id/runs/:runId/start", func(c echo.Context) error {
		var in struct {
			Expected   int    `json:"expectedRevision"`
			ApprovalID string `json:"approvalId"`
			Version    string `json:"detectedVersion"`
			DeviceID   string `json:"deviceId"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		r, e := s.run(c)
		if e != nil {
			return e
		}
		if e = s.checkRevision(c, r, in.Expected); e != nil {
			return e
		}
		if str(r, "state") != "APPROVAL_REQUIRED" {
			return conflict("이미 시작되었거나 종료된 실행입니다")
		}
		if !length(in.Version, 1, 100) || !validID(in.DeviceID) {
			return invalid("실제 설치 버전과 deviceId가 필요합니다")
		}
		if e = s.consumeApproval(c, in.ApprovalID, "CLI_EXECUTE", str(r, "applicationId"), r); e != nil {
			return e
		}
		r["state"] = "RUNNING"
		r["approvalId"] = in.ApprovalID
		r["deviceId"] = in.DeviceID
		r["detectedVersion"] = in.Version
		r["startedAt"] = time.Now().UTC()
		return s.save(c, "runs", r, in.Expected)
	})
	g.POST("/projects/:id/runs/:runId/launch", func(c echo.Context) error {
		var in struct {
			Expected int      `json:"expectedRevision"`
			DeviceID string   `json:"deviceId"`
			Hash     string   `json:"payloadHash"`
			Status   string   `json:"launchStatus"`
			Process  *Process `json:"process"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		r, e := s.run(c)
		if e != nil {
			return e
		}
		if e = s.checkRevision(c, r, in.Expected); e != nil {
			return e
		}
		if str(r, "state") != "RUNNING" || str(r, "deviceId") != in.DeviceID || str(r, "payloadHash") != in.Hash {
			return fail(409, "APPROVAL_STALE", "실행 기기나 payload가 다릅니다")
		}
		prior := str(r, "launchStatus")
		if !(prior == "NOT_CLAIMED" && in.Status == "CLAIMED" || prior == "CLAIMED" && in.Status == "STARTED" || oneOf(prior, "CLAIMED", "STARTED") && in.Status == "UNKNOWN") {
			return conflict("잘못된 launch 전이입니다")
		}
		if in.Status == "STARTED" && (in.Process == nil || in.Process.PID < 1 || !validTime(in.Process.StartedAt) || in.Process.StartedAt == "") {
			return invalid("실제 프로세스 ID와 시작 시각이 필요합니다")
		}
		r["launchStatus"] = in.Status
		if in.Process != nil {
			r["process"] = in.Process
		}
		return s.save(c, "runs", r, in.Expected)
	})
	g.POST("/projects/:id/runs/:runId/recover", func(c echo.Context) error {
		var in struct {
			Expected int      `json:"expectedRevision"`
			DeviceID string   `json:"deviceId"`
			Decision string   `json:"decision"`
			Process  *Process `json:"process"`
			Reason   string   `json:"failureReason"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		r, e := s.run(c)
		if e != nil {
			return e
		}
		if str(r, "launchStatus") != "UNKNOWN" || str(r, "deviceId") != in.DeviceID {
			return conflict("복구 가능한 실행이 아닙니다")
		}
		if in.Decision == "MARK_FAILED" {
			if !nonempty(in.Reason) {
				return invalid("실패 원인이 필요합니다")
			}
			r["state"] = "FAILED"
			r["failureReason"] = in.Reason
			r["finishedAt"] = time.Now().UTC()
		} else if in.Decision == "REATTACH" {
			if in.Process == nil || in.Process.PID < 1 || !validTime(in.Process.StartedAt) || in.Process.StartedAt == "" {
				return invalid("프로세스를 확인하세요")
			}
			if r["process"] != nil && hashJSON(r["process"]) != hashJSON(in.Process) {
				return conflict("기존 프로세스가 아닙니다")
			}
			r["process"] = in.Process
			r["launchStatus"] = "STARTED"
		} else {
			return invalid("복구 결정 오류")
		}
		return s.save(c, "runs", r, in.Expected)
	})
	g.POST("/projects/:id/runs/:runId/result", func(c echo.Context) error {
		var in struct {
			Expected int    `json:"expectedRevision"`
			ExitCode int    `json:"exitCode"`
			SHA      string `json:"commitSha"`
			Stdout   string `json:"stdoutHash"`
			Stderr   string `json:"stderrHash"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		r, e := s.run(c)
		if e != nil {
			return e
		}
		if str(r, "state") != "RUNNING" || str(r, "launchStatus") != "STARTED" {
			return conflict("실행 중 프로세스가 아닙니다")
		}
		if len(in.Stdout) != 64 || len(in.Stderr) != 64 || in.SHA != "" && len(in.SHA) != 40 {
			return invalid("실행 해시 오류")
		}
		r["state"] = "VERIFYING"
		if in.ExitCode != 0 {
			r["state"] = "FAILED"
			r["failureReason"] = "CLI_EXIT_NONZERO"
		}
		r["launchStatus"] = "FINISHED"
		r["finishedAt"] = time.Now().UTC()
		r["exitCode"] = in.ExitCode
		r["commitSha"] = nullable(in.SHA)
		r["stdoutHash"] = in.Stdout
		r["stderrHash"] = in.Stderr
		return s.save(c, "runs", r, in.Expected)
	})
	g.POST("/projects/:id/evidence", func(c echo.Context) error {
		var in struct {
			RunID     string   `json:"runId"`
			CommitURL string   `json:"commitUrl"`
			Command   string   `json:"testCommand"`
			Output    string   `json:"testOutput"`
			ExitCode  int      `json:"exitCode"`
			Metrics   []Metric `json:"metrics"`
			Summary   string   `json:"summary"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		r, e := s.get(c, "runs", in.RunID)
		if e != nil {
			return e
		}
		if str(r, "projectId") != c.Param("id") || str(r, "state") != "VERIFYING" {
			return conflict("검증 중 실행이 아닙니다")
		}
		parts := strings.Split(in.CommitURL, "/")
		if len(parts) != 7 || parts[0] != "https:" || parts[2] != "github.com" || parts[5] != "commit" || len(parts[6]) != 40 || !nonempty(in.Command, in.Output, in.Summary) || len(in.Metrics) == 0 {
			return invalid("커밋·실행·측정 증빙을 확인하세요")
		}
		for _, m := range in.Metrics {
			if !nonempty(m.Name, m.Unit) {
				return invalid("지표 이름과 단위가 필요합니다")
			}
		}
		v, e := s.create(c, "project-evidence", str(r, "applicationId"), map[string]any{"projectId": r["projectId"], "applicationId": r["applicationId"], "runId": r["id"], "commitUrl": in.CommitURL, "commitSha": parts[6], "testResults": map[string]any{"command": in.Command, "output": in.Output, "exitCode": in.ExitCode}, "metrics": in.Metrics, "summary": in.Summary, "status": "PENDING", "verificationMethod": "USER_PROVIDED", "verifiedAt": nil, "careerEvidenceId": nil})
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.POST("/projects/:id/evidence/:evidenceId/verify", func(c echo.Context) error {
		var in struct {
			Expected int `json:"expectedRevision"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		v, e := s.get(c, "project-evidence", c.Param("evidenceId"))
		if e != nil {
			return e
		}
		if str(v, "projectId") != c.Param("id") {
			return fail(404, "NOT_FOUND", "프로젝트 증빙이 없습니다")
		}
		if e = s.checkRevision(c, v, in.Expected); e != nil {
			return e
		}
		return s.operation(c, "PROJECT_VERIFY", str(v, "applicationId"), v)
	})
}

type Process struct {
	PID       int    `json:"pid"`
	StartedAt string `json:"startedAt"`
}
type Metric struct {
	Name  string  `json:"name"`
	Value float64 `json:"value"`
	Unit  string  `json:"unit"`
}

func (s *Server) run(c echo.Context) (map[string]any, error) {
	r, e := s.get(c, "runs", c.Param("runId"))
	if e != nil {
		return nil, e
	}
	if str(r, "projectId") != c.Param("id") {
		return nil, fail(404, "NOT_FOUND", "실행이 없습니다")
	}
	return r, nil
}
