package main

import (
	"fmt"
	"github.com/labstack/echo/v4"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

type EvidenceInput struct {
	Kind       string   `json:"kind"`
	Title      string   `json:"title"`
	SourceText string   `json:"sourceText"`
	SourceURL  string   `json:"sourceUrl,omitempty"`
	Skills     []string `json:"skills"`
}
type JobInput struct {
	Company      string   `json:"company"`
	Title        string   `json:"title"`
	SourceText   string   `json:"sourceText"`
	SourceURL    string   `json:"sourceUrl,omitempty"`
	SourceKind   string   `json:"sourceKind"`
	Requirements []string `json:"requirements"`
	Preferred    []string `json:"preferred"`
	Deadline     string   `json:"deadline,omitempty"`
}
type Block struct {
	Text        string   `json:"text"`
	EvidenceIDs []string `json:"evidenceIds"`
}

func validURL(value string) bool {
	if value == "" {
		return true
	}
	u, e := url.Parse(value)
	return e == nil && oneOf(u.Scheme, "https", "http") && u.Hostname() != "" && u.User == nil
}
func validTime(value string) bool {
	if value == "" {
		return true
	}
	_, err := time.Parse(time.RFC3339, value)
	return err == nil
}
func (s *Server) domainRoutes(g *echo.Group) {
	for _, kind := range []string{"career-evidence", "jobs", "applications", "documents", "projects", "interviews", "offers", "routines", "approvals"} {
		k := kind
		g.GET("/"+k, func(c echo.Context) error {
			v, e := s.list(c, k, c.QueryParam("applicationId"))
			if e != nil {
				return e
			}
			return ok(c, 200, v)
		})
		g.GET("/"+k+"/:id", func(c echo.Context) error {
			v, e := s.get(c, k, c.Param("id"))
			if e != nil {
				return e
			}
			return ok(c, 200, v)
		})
	}
	g.POST("/career-evidence", func(c echo.Context) error {
		var in EvidenceInput
		if e := decode(c, &in); e != nil {
			return e
		}
		if !oneOf(in.Kind, "RESUME", "GITHUB", "CAREER", "EDUCATION", "SKILL", "PROJECT") || !nonempty(in.Title, in.SourceText) || !validURL(in.SourceURL) {
			return invalid("근거 종류·제목·원문을 확인하세요")
		}
		if in.Skills == nil {
			in.Skills = []string{}
		}
		v, e := s.create(c, "career-evidence", "", in)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.POST("/career-evidence/import", func(c echo.Context) error {
		var in struct {
			Text      string `json:"text"`
			SourceURL string `json:"sourceUrl"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if !nonempty(in.Text) || !validURL(in.SourceURL) {
			return invalid("원문을 입력하세요")
		}
		result := []any{}
		for _, paragraph := range strings.Split(strings.ReplaceAll(in.Text, "\r\n", "\n"), "\n\n") {
			if !nonempty(paragraph) {
				continue
			}
			title := strings.Split(paragraph, "\n")[0]
			r := []rune(title)
			if len(r) > 80 {
				title = string(r[:80])
			}
			v, e := s.create(c, "career-evidence", "", EvidenceInput{Kind: "RESUME", Title: title, SourceText: paragraph, SourceURL: in.SourceURL, Skills: []string{}})
			if e != nil {
				return e
			}
			result = append(result, v)
		}
		return ok(c, 201, result)
	})
	g.POST("/jobs", func(c echo.Context) error {
		var in JobInput
		if e := decode(c, &in); e != nil {
			return e
		}
		if !nonempty(in.Company, in.Title, in.SourceText) || !oneOf(in.SourceKind, "TEXT", "URL", "DOM") || !validURL(in.SourceURL) || !validTime(in.Deadline) {
			return invalid("공고 원문·회사·제목·입력 형식을 확인하세요")
		}
		if in.SourceKind != "TEXT" && in.SourceURL == "" {
			return invalid("URL/DOM 수집에는 원본 URL이 필요합니다")
		}
		if in.Requirements == nil {
			in.Requirements = []string{}
		}
		if in.Preferred == nil {
			in.Preferred = []string{}
		}
		v, e := s.create(c, "jobs", "", in)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.POST("/jobs/:id/analyze", func(c echo.Context) error {
		j, e := s.get(c, "jobs", c.Param("id"))
		if e != nil {
			return e
		}
		v, e := s.analyze(c, j)
		if e != nil {
			return e
		}
		return ok(c, 200, v)
	})
	g.POST("/applications", func(c echo.Context) error {
		var in struct {
			JobID string `json:"jobId"`
			Notes string `json:"notes"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		j, e := s.get(c, "jobs", in.JobID)
		if e != nil {
			return e
		}
		v, e := s.create(c, "applications", "", map[string]any{"jobId": in.JobID, "company": j["company"], "title": j["title"], "notes": in.Notes, "stage": "DISCOVERED"})
		if e != nil {
			return e
		}
		_, e = s.q(c).Exec(c.Request().Context(), "UPDATE resources SET application_id=id WHERE id=$1", v["id"])
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.PATCH("/applications/:id", func(c echo.Context) error {
		var in struct {
			Expected int     `json:"expectedRevision"`
			Stage    string  `json:"stage"`
			Notes    *string `json:"notes"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		v, e := s.get(c, "applications", c.Param("id"))
		if e != nil {
			return e
		}
		st := str(v, "stage")
		next := map[string]string{"DISCOVERED": "PREPARING", "PREPARING": "READY", "READY": "APPLIED", "APPLIED": "SCREENING", "SCREENING": "INTERVIEW", "INTERVIEW": "OFFER", "OFFER": "ACCEPTED"}
		if next[st] == "" || in.Stage != next[st] && !oneOf(in.Stage, "WITHDRAWN", "REJECTED") {
			return conflict("허용되지 않는 지원 단계 변경입니다")
		}
		if in.Stage == "APPLIED" {
			if e = s.requireApproval(c, "APPLICATION_SUBMIT", str(v, "id")); e != nil {
				return e
			}
		}
		v["stage"] = in.Stage
		if in.Notes != nil {
			v["notes"] = *in.Notes
		}
		v, e = s.update(c, "applications", v, in.Expected)
		if e != nil {
			return e
		}
		return ok(c, 200, v)
	})
	g.POST("/approvals", func(c echo.Context) error {
		var in struct {
			Kind     string `json:"kind"`
			TargetID string `json:"targetId"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		k := map[string]string{"EVIDENCE_USE": "career-evidence", "DOCUMENT_FINALIZE": "versions", "APPLICATION_SUBMIT": "applications", "CLI_EXECUTE": "runs"}[in.Kind]
		if k == "" {
			return invalid("승인 종류를 확인하세요")
		}
		target, e := s.get(c, k, in.TargetID)
		if e != nil {
			return e
		}
		v, e := s.create(c, "approvals", str(target, "applicationId"), map[string]any{"kind": in.Kind, "targetId": in.TargetID, "status": "PENDING"})
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.POST("/approvals/:id/decision", func(c echo.Context) error {
		var in struct {
			Decision string `json:"decision"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if !oneOf(in.Decision, "APPROVED", "DENIED") {
			return invalid("APPROVED 또는 DENIED를 입력하세요")
		}
		v, e := s.get(c, "approvals", c.Param("id"))
		if e != nil {
			return e
		}
		if str(v, "status") != "PENDING" {
			return conflict("이미 결정한 승인입니다")
		}
		v["status"] = in.Decision
		v["decidedAt"] = time.Now().UTC()
		v, e = s.update(c, "approvals", v, number(v, "revision"))
		if e != nil {
			return e
		}
		return ok(c, 200, v)
	})
	s.documentRoutes(g)
	s.projectRoutes(g)
	s.followupRoutes(g)
}
func (s *Server) analyze(c echo.Context, j map[string]any) (map[string]any, error) {
	evidence, e := s.list(c, "career-evidence", "")
	if e != nil {
		return nil, e
	}
	skills := map[string][]string{}
	for _, x := range evidence {
		m := x.(map[string]any)
		for _, skill := range stringsAt(m, "skills") {
			k := strings.ToLower(strings.TrimSpace(skill))
			skills[k] = append(skills[k], str(m, "id"))
		}
	}
	matched := []any{}
	missing := []string{}
	preferred := []string{}
	required := stringsAt(j, "requirements")
	for _, r := range required {
		if ids := skills[strings.ToLower(strings.TrimSpace(r))]; len(ids) > 0 {
			matched = append(matched, map[string]any{"skill": r, "evidenceIds": ids})
		} else {
			missing = append(missing, r)
		}
	}
	for _, r := range stringsAt(j, "preferred") {
		if len(skills[strings.ToLower(strings.TrimSpace(r))]) == 0 {
			preferred = append(preferred, r)
		}
	}
	score := 0
	if len(required) > 0 {
		score = len(matched) * 100 / len(required)
	}
	risks := []string{}
	if len(required) == 0 {
		risks = append(risks, "명시된 필수 요구사항이 없습니다")
	}
	if len(missing) > 0 {
		risks = append(risks, "필수 역량 중 원본 근거가 없는 항목이 있습니다")
	}
	return map[string]any{"jobId": j["id"], "matched": matched, "missing": missing, "preferredMissing": preferred, "keywords": append(required, stringsAt(j, "preferred")...), "risks": risks, "fitScore": score}, nil
}
func (s *Server) documentRoutes(g *echo.Group) {
	g.POST("/documents", func(c echo.Context) error {
		var in struct {
			ApplicationID string `json:"applicationId"`
			Title         string `json:"title"`
			Kind          string `json:"kind"`
			Template      string `json:"template"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if !nonempty(in.Title) || !oneOf(in.Kind, "RESUME", "PORTFOLIO", "COVER_LETTER") || !oneOf(in.Template, "CLASSIC", "MODERN", "COMPACT") {
			return invalid("문서 종류·템플릿·제목을 확인하세요")
		}
		if _, e := s.get(c, "applications", in.ApplicationID); e != nil {
			return e
		}
		m := fields(in)
		m["status"] = "DRAFT"
		m["latestVersionId"] = ""
		m["finalizedVersionId"] = ""
		v, e := s.create(c, "documents", in.ApplicationID, m)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.GET("/documents/:id/versions", func(c echo.Context) error {
		d, e := s.get(c, "documents", c.Param("id"))
		if e != nil {
			return e
		}
		all, e := s.list(c, "versions", str(d, "applicationId"))
		if e != nil {
			return e
		}
		out := []any{}
		for _, v := range all {
			if str(v.(map[string]any), "documentId") == c.Param("id") {
				out = append(out, v)
			}
		}
		return ok(c, 200, out)
	})
	g.POST("/documents/:id/versions", func(c echo.Context) error {
		var in struct {
			Expected   int     `json:"expectedRevision"`
			Blocks     []Block `json:"blocks"`
			ChangeNote string  `json:"changeNote"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		return s.addVersion(c, in.Expected, in.Blocks, in.ChangeNote)
	})
	g.POST("/documents/:id/generate", func(c echo.Context) error {
		var in struct {
			Expected    int      `json:"expectedRevision"`
			EvidenceIDs []string `json:"evidenceIds"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		blocks := []Block{}
		for _, id := range in.EvidenceIDs {
			ev, e := s.get(c, "career-evidence", id)
			if e != nil {
				return e
			}
			blocks = append(blocks, Block{Text: str(ev, "sourceText"), EvidenceIDs: []string{id}})
		}
		return s.addVersion(c, in.Expected, blocks, "원본 근거 발췌")
	})
	g.POST("/documents/:id/finalize", func(c echo.Context) error {
		var in struct {
			Expected  int    `json:"expectedRevision"`
			VersionID string `json:"versionId"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		d, e := s.get(c, "documents", c.Param("id"))
		if e != nil {
			return e
		}
		v, e := s.get(c, "versions", in.VersionID)
		if e != nil {
			return e
		}
		if str(v, "documentId") != str(d, "id") || str(v, "applicationId") != str(d, "applicationId") {
			return conflict("다른 문서의 버전입니다")
		}
		if e = s.requireApproval(c, "DOCUMENT_FINALIZE", in.VersionID); e != nil {
			return e
		}
		var parsed struct {
			Blocks []Block `json:"blocks"`
		}
		b := fields(v)
		for _, raw := range b["blocks"].([]any) {
			m := raw.(map[string]any)
			parsed.Blocks = append(parsed.Blocks, Block{Text: str(m, "text"), EvidenceIDs: stringsAt(m, "evidenceIds")})
		}
		for _, block := range parsed.Blocks {
			grounded := false
			for _, eid := range block.EvidenceIDs {
				ev, err := s.get(c, "career-evidence", eid)
				if err != nil {
					return err
				}
				if err = s.requireApproval(c, "EVIDENCE_USE", eid); err != nil {
					return err
				}
				if strings.Contains(str(ev, "sourceText"), block.Text) {
					grounded = true
				}
			}
			if !grounded {
				return fail(409, "UNSUPPORTED_CLAIM", "원문에서 확인되지 않는 문장은 확정할 수 없습니다")
			}
		}
		d["status"] = "FINALIZED"
		d["finalizedVersionId"] = in.VersionID
		d, e = s.update(c, "documents", d, in.Expected)
		if e != nil {
			return e
		}
		return ok(c, 200, d)
	})
}
func (s *Server) addVersion(c echo.Context, expected int, blocks []Block, note string) error {
	if len(blocks) == 0 || len(blocks) > 200 {
		return invalid("문서에는 1~200개 블록이 필요합니다")
	}
	d, e := s.get(c, "documents", c.Param("id"))
	if e != nil {
		return e
	}
	if number(d, "revision") != expected {
		return conflict("문서가 변경되었습니다")
	}
	a, e := s.get(c, "applications", str(d, "applicationId"))
	if e != nil {
		return e
	}
	j, e := s.get(c, "jobs", str(a, "jobId"))
	if e != nil {
		return e
	}
	grounded := 0
	content := ""
	issues := []string{}
	for _, block := range blocks {
		if !nonempty(block.Text) || len(block.EvidenceIDs) == 0 {
			return invalid("모든 문장에 근거를 연결하세요")
		}
		valid := false
		for _, eid := range block.EvidenceIDs {
			ev, e := s.get(c, "career-evidence", eid)
			if e != nil {
				return e
			}
			if strings.Contains(str(ev, "sourceText"), block.Text) {
				valid = true
			}
		}
		if valid {
			grounded++
		} else {
			issues = append(issues, "원문에서 확인되지 않는 문장이 있습니다")
		}
		content += block.Text + "\n"
	}
	matched := 0
	keywords := append(stringsAt(j, "requirements"), stringsAt(j, "preferred")...)
	for _, k := range keywords {
		if strings.Contains(strings.ToLower(content), strings.ToLower(k)) {
			matched++
		}
	}
	fit := 0
	if len(keywords) > 0 {
		fit = matched * 100 / len(keywords)
	}
	readability := 100
	if utf8.RuneCountInString(content)/len(blocks) > 250 {
		readability = 60
		issues = append(issues, "긴 문장을 나누세요")
	}
	var count int
	if e = s.q(c).QueryRow(c.Request().Context(), "SELECT count(*) FROM resources WHERE owner_id=$1 AND kind='versions' AND body->>'documentId'=$2", owner(c), str(d, "id")).Scan(&count); e != nil {
		return e
	}
	v, e := s.create(c, "versions", str(d, "applicationId"), map[string]any{"documentId": d["id"], "applicationId": d["applicationId"], "number": count + 1, "blocks": blocks, "changeNote": note, "quality": map[string]any{"jobFit": fit, "ats": fit, "evidenceFidelity": grounded * 100 / len(blocks), "readability": readability, "issues": issues}})
	if e != nil {
		return e
	}
	d["latestVersionId"] = v["id"]
	d["status"] = "DRAFT"
	d["finalizedVersionId"] = ""
	if _, e = s.update(c, "documents", d, expected); e != nil {
		return e
	}
	return ok(c, 201, v)
}
func (s *Server) projectRoutes(g *echo.Group) {
	g.POST("/projects/blueprints", func(c echo.Context) error {
		var in struct {
			ApplicationID string `json:"applicationId"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		a, e := s.get(c, "applications", in.ApplicationID)
		if e != nil {
			return e
		}
		j, e := s.get(c, "jobs", str(a, "jobId"))
		if e != nil {
			return e
		}
		skills := stringsAt(j, "requirements")
		if len(skills) == 0 {
			return invalid("블루프린트를 만들려면 공고의 필수 기술을 입력하세요")
		}
		analysis, e := s.analyze(c, j)
		if e != nil {
			return e
		}
		out := []any{}
		themes := []struct {
			title, problem, solution, metric string
			tasks                            []string
		}{
			{"지원 자료 검색", "자료가 늘어나면 필요한 원문을 찾기 어렵습니다", "원문과 검색 색인을 분리하고 검색 정확도를 측정합니다", "검색 p95 응답 시간", []string{"원문·색인 데이터 모델 정의", "검색 및 필터 API 구현", "검색 화면 구현", "정답이 있는 검색 사례와 지연 시간 측정"}},
			{"일정 충돌 방지", "동시에 일정을 예약하면 중복 예약이 발생합니다", "저장소 제약과 원자적 예약 처리를 적용합니다", "동시 요청 중 중복 예약 수", []string{"일정·예약 데이터 모델 정의", "원자적 예약 API 구현", "달력·충돌 안내 화면 구현", "동시 예약 테스트와 실패 복구 확인"}},
			{"문서 버전 보관", "여러 기기의 편집이 마지막 저장으로 소실됩니다", "불변 버전과 revision 조건부 저장으로 충돌을 탐지합니다", "충돌 테스트 중 소실된 편집 수", []string{"문서·버전 데이터 모델 정의", "조건부 저장과 충돌 API 구현", "버전 비교 화면 구현", "동시 편집 및 복원 테스트"}},
			{"후속 작업 큐", "실패한 작업을 재시도하면 중복 실행됩니다", "멱등 키와 재시도 상태를 영속화합니다", "재시도 중 중복 부작용 수", []string{"작업·실행 이력 데이터 모델 정의", "멱등 실행 API 구현", "작업 상태 화면 구현", "장애 주입과 재시도 검증"}},
		}
		for _, theme := range themes {
			v, e := s.create(c, "projects", in.ApplicationID, map[string]any{"applicationId": in.ApplicationID, "title": str(j, "company") + " · " + theme.title, "skills": skills, "gaps": analysis["missing"], "problem": theme.problem, "solution": theme.solution, "tasks": theme.tasks, "completionCriteria": []string{"핵심 사용자 흐름 실행", "성공·실패·동시성 테스트 통과", "GitHub 커밋과 테스트 결과 보관", "변경 전후 지표 측정 및 단위 기록"}, "metrics": []string{theme.metric}, "state": "DRAFT"})
			if e != nil {
				return e
			}
			out = append(out, v)
		}
		return ok(c, 201, out)
	})
	g.GET("/projects/:id/runs", func(c echo.Context) error {
		p, e := s.get(c, "projects", c.Param("id"))
		if e != nil {
			return e
		}
		all, e := s.list(c, "runs", str(p, "applicationId"))
		if e != nil {
			return e
		}
		out := []any{}
		for _, x := range all {
			if str(x.(map[string]any), "projectId") == c.Param("id") {
				out = append(out, x)
			}
		}
		return ok(c, 200, out)
	})
	g.POST("/projects/:id/runs", func(c echo.Context) error {
		var in struct {
			Provider         string `json:"provider"`
			WorkingDirectory string `json:"workingDirectory"`
			Prompt           string `json:"prompt"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		command := map[string]string{"CODEX": "codex", "CLAUDE_CODE": "claude", "GROK_BUILD": "grok"}[in.Provider]
		if command == "" || !nonempty(in.WorkingDirectory, in.Prompt) || strings.ContainsAny(in.WorkingDirectory, "\x00\n\r") {
			return invalid("CLI·작업 폴더·프롬프트를 확인하세요")
		}
		p, e := s.get(c, "projects", c.Param("id"))
		if e != nil {
			return e
		}
		m := fields(in)
		m["command"] = command
		m["state"] = "APPROVAL_REQUIRED"
		m["projectId"] = p["id"]
		m["applicationId"] = p["applicationId"]
		v, e := s.create(c, "runs", str(p, "applicationId"), m)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.PATCH("/projects/:id/runs/:runId", func(c echo.Context) error {
		var in struct {
			Expected      int    `json:"expectedRevision"`
			State         string `json:"state"`
			FailureReason string `json:"failureReason"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		r, e := s.get(c, "runs", c.Param("runId"))
		if e != nil {
			return e
		}
		if str(r, "projectId") != c.Param("id") {
			return fail(404, "NOT_FOUND", "실행을 찾을 수 없습니다")
		}
		state := str(r, "state")
		allowed := state == "APPROVAL_REQUIRED" && in.State == "RUNNING" || state == "RUNNING" && in.State == "VERIFYING" || oneOf(state, "APPROVAL_REQUIRED", "RUNNING", "VERIFYING") && in.State == "FAILED"
		if !allowed {
			return conflict("허용되지 않는 실행 단계 변경입니다")
		}
		if in.State == "RUNNING" {
			if e = s.requireApproval(c, "CLI_EXECUTE", str(r, "id")); e != nil {
				return e
			}
		}
		if in.State == "FAILED" && !nonempty(in.FailureReason) {
			return invalid("실패 원인을 입력하세요")
		}
		r["state"] = in.State
		r["failureReason"] = in.FailureReason
		r, e = s.update(c, "runs", r, in.Expected)
		if e != nil {
			return e
		}
		return ok(c, 200, r)
	})
	g.POST("/projects/:id/evidence", func(c echo.Context) error {
		var in struct {
			RunID       string `json:"runId"`
			CommitURL   string `json:"commitUrl"`
			TestCommand string `json:"testCommand"`
			TestOutput  string `json:"testOutput"`
			ExitCode    int    `json:"exitCode"`
			Metrics     []struct {
				Name  string  `json:"name"`
				Value float64 `json:"value"`
				Unit  string  `json:"unit"`
			} `json:"metrics"`
			Summary string `json:"summary"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		r, e := s.get(c, "runs", in.RunID)
		if e != nil {
			return e
		}
		if str(r, "projectId") != c.Param("id") {
			return fail(404, "NOT_FOUND", "실행을 찾을 수 없습니다")
		}
		if str(r, "state") != "VERIFYING" {
			return conflict("검증 단계에서만 증빙을 등록하세요")
		}
		if !regexp.MustCompile(`^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/commit/[a-fA-F0-9]{40}$`).MatchString(in.CommitURL) || in.ExitCode != 0 || !nonempty(in.TestCommand, in.TestOutput, in.Summary) || len(in.Metrics) == 0 {
			return invalid("성공한 실행 결과·커밋·측정 지표가 필요합니다")
		}
		for _, m := range in.Metrics {
			if !nonempty(m.Name, m.Unit) {
				return invalid("측정 이름과 단위를 입력하세요")
			}
		}
		m := fields(in)
		m["applicationId"] = r["applicationId"]
		m["projectId"] = r["projectId"]
		m["verificationMethod"] = "USER_ATTESTED"
		m["verified"] = false
		m["status"] = "PENDING_INDEPENDENT_VERIFICATION"
		v, e := s.create(c, "project-evidence", str(r, "applicationId"), m)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
}
func (s *Server) followupRoutes(g *echo.Group) {
	g.POST("/interviews", func(c echo.Context) error {
		var in struct {
			ApplicationID string   `json:"applicationId"`
			Title         string   `json:"title"`
			ScheduledAt   string   `json:"scheduledAt"`
			Notes         string   `json:"notes"`
			EvidenceIDs   []string `json:"evidenceIds"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if !nonempty(in.Title, in.ScheduledAt) || !validTime(in.ScheduledAt) {
			return invalid("면접 제목과 일시를 확인하세요")
		}
		if _, e := s.get(c, "applications", in.ApplicationID); e != nil {
			return e
		}
		for _, eid := range in.EvidenceIDs {
			if _, e := s.get(c, "career-evidence", eid); e != nil {
				return e
			}
		}
		if in.EvidenceIDs == nil {
			in.EvidenceIDs = []string{}
		}
		m := fields(in)
		m["reflection"] = ""
		v, e := s.create(c, "interviews", in.ApplicationID, m)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.PATCH("/interviews/:id", func(c echo.Context) error {
		var in struct {
			Expected   int    `json:"expectedRevision"`
			Notes      string `json:"notes"`
			Reflection string `json:"reflection"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		v, e := s.get(c, "interviews", c.Param("id"))
		if e != nil {
			return e
		}
		v["notes"] = in.Notes
		v["reflection"] = in.Reflection
		v, e = s.update(c, "interviews", v, in.Expected)
		if e != nil {
			return e
		}
		return ok(c, 200, v)
	})
	g.POST("/interviews/:id/prepare", func(c echo.Context) error {
		v, e := s.get(c, "interviews", c.Param("id"))
		if e != nil {
			return e
		}
		a, e := s.get(c, "applications", str(v, "applicationId"))
		if e != nil {
			return e
		}
		j, e := s.get(c, "jobs", str(a, "jobId"))
		if e != nil {
			return e
		}
		questions := []string{}
		for _, k := range stringsAt(j, "requirements") {
			questions = append(questions, fmt.Sprintf("%s를 사용한 경험과 기술 선택의 이유를 설명해 주세요.", k))
		}
		answers := []any{}
		for _, eid := range stringsAt(v, "evidenceIds") {
			ev, e := s.get(c, "career-evidence", eid)
			if e != nil {
				return e
			}
			answers = append(answers, map[string]any{"evidenceId": eid, "situation": "", "task": "", "action": ev["sourceText"], "result": "", "needsInput": []string{"situation", "task", "result"}})
		}
		return ok(c, 200, map[string]any{"questions": questions, "starAnswers": answers, "researchNotes": j["sourceText"]})
	})
	g.POST("/offers", func(c echo.Context) error {
		var in struct {
			ApplicationID string `json:"applicationId"`
			Company       string `json:"company"`
			AnnualSalary  int64  `json:"annualSalary"`
			Currency      string `json:"currency"`
			Equity        string `json:"equity"`
			Notes         string `json:"notes"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if !nonempty(in.Company) || in.AnnualSalary < 0 || !oneOf(in.Currency, "KRW", "USD", "EUR", "JPY", "GBP", "CAD", "AUD") {
			return invalid("회사·연봉·통화를 확인하세요")
		}
		if _, e := s.get(c, "applications", in.ApplicationID); e != nil {
			return e
		}
		v, e := s.create(c, "offers", in.ApplicationID, in)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.GET("/offers/compare", func(c echo.Context) error {
		v, e := s.list(c, "offers", "")
		if e != nil {
			return e
		}
		return ok(c, 200, v)
	})
	g.POST("/routines", func(c echo.Context) error {
		var in struct {
			Title         string `json:"title"`
			Kind          string `json:"kind"`
			ApplicationID string `json:"applicationId"`
			DueAt         string `json:"dueAt"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if !nonempty(in.Title, in.DueAt) || !validTime(in.DueAt) || !oneOf(in.Kind, "DEADLINE", "FOLLOW_UP", "INTERVIEW_PREP") {
			return invalid("루틴 내용을 확인하세요")
		}
		if _, e := s.get(c, "applications", in.ApplicationID); e != nil {
			return e
		}
		m := fields(in)
		m["status"] = "PENDING"
		v, e := s.create(c, "routines", in.ApplicationID, m)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.PATCH("/routines/:id", func(c echo.Context) error {
		var in struct {
			Expected int    `json:"expectedRevision"`
			Status   string `json:"status"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		v, e := s.get(c, "routines", c.Param("id"))
		if e != nil {
			return e
		}
		state := str(v, "status")
		if !(state == "PENDING" && oneOf(in.Status, "CONFIRMED", "DISMISSED") || state == "CONFIRMED" && oneOf(in.Status, "DONE", "DISMISSED")) {
			return conflict("허용되지 않는 루틴 변경입니다")
		}
		v["status"] = in.Status
		v, e = s.update(c, "routines", v, in.Expected)
		if e != nil {
			return e
		}
		return ok(c, 200, v)
	})
	g.POST("/routines/suggest", func(c echo.Context) error {
		apps, e := s.list(c, "applications", "")
		if e != nil {
			return e
		}
		out := []any{}
		now := time.Now().UTC()
		for _, x := range apps {
			a := x.(map[string]any)
			if oneOf(str(a, "stage"), "ACCEPTED", "REJECTED", "WITHDRAWN") {
				continue
			}
			j, e := s.get(c, "jobs", str(a, "jobId"))
			if e != nil {
				return e
			}
			deadline, err := time.Parse(time.RFC3339, str(j, "deadline"))
			if err == nil && deadline.After(now) && deadline.Before(now.Add(72*time.Hour)) {
				out = append(out, map[string]any{"applicationId": a["id"], "kind": "DEADLINE", "title": str(j, "company") + " 공고 마감 확인", "dueAt": deadline})
			}
			updated, _ := a["updatedAt"].(time.Time)
			if oneOf(str(a, "stage"), "APPLIED", "SCREENING") && updated.Before(now.Add(-7*24*time.Hour)) {
				out = append(out, map[string]any{"applicationId": a["id"], "kind": "FOLLOW_UP", "title": str(j, "company") + " 지원 결과 확인", "dueAt": now})
			}
		}
		interviews, e := s.list(c, "interviews", "")
		if e != nil {
			return e
		}
		for _, x := range interviews {
			v := x.(map[string]any)
			at, err := time.Parse(time.RFC3339, str(v, "scheduledAt"))
			if err == nil && at.After(now) && at.Before(now.Add(72*time.Hour)) {
				out = append(out, map[string]any{"applicationId": v["applicationId"], "kind": "INTERVIEW_PREP", "title": str(v, "title") + " 준비", "dueAt": at.Add(-time.Hour)})
			}
		}
		return ok(c, 200, out)
	})
}
