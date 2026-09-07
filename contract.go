package main

import (
	"encoding/json"
	"github.com/labstack/echo/v4"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

type AiOptions struct {
	Provider       string `json:"provider"`
	Model          string `json:"model"`
	CredentialMode string `json:"credentialMode"`
	Effort         string `json:"effort"`
}

func length(value string, min, max int) bool {
	n := utf8.RuneCountInString(value)
	return n >= min && n <= max && strings.TrimSpace(value) != ""
}
func validStrings(values []string, max int) bool {
	if len(values) > max {
		return false
	}
	for _, v := range values {
		if !length(v, 1, 100) {
			return false
		}
	}
	return true
}
func (s *Server) checkRevision(c echo.Context, m map[string]any, expected int) error {
	if expected < 1 {
		return invalid("expectedRevision 양의 정수가 필요합니다")
	}
	if number(m, "revision") != expected {
		c.Set("errorDetails", map[string]any{"currentRevision": m["revision"]})
		return fail(409, "REVISION_CONFLICT", "리소스가 변경되었습니다")
	}
	return nil
}
func (s *Server) save(c echo.Context, kind string, m map[string]any, expected int) error {
	if e := s.checkRevision(c, m, expected); e != nil {
		return e
	}
	v, e := s.update(c, kind, m, expected)
	if e != nil {
		return e
	}
	return ok(c, 200, v)
}
func (s *Server) contractRoutes(g *echo.Group) {
	for _, kind := range []string{"career-evidence", "jobs", "applications", "documents", "projects", "interviews", "offers", "routines", "approvals", "conversations", "pins"} {
		k := kind
		g.GET("/"+k, func(c echo.Context) error {
			v, e := s.list(c, k, c.QueryParam("applicationId"))
			if e != nil {
				return e
			}
			out := []any{}
			for _, raw := range v {
				m := raw.(map[string]any)
				keep := true
				for _, field := range []string{"kind", "stage", "status"} {
					if val := c.QueryParam(field); val != "" && str(m, field) != val {
						keep = false
					}
				}
				if q := strings.ToLower(c.QueryParam("query")); q != "" && !strings.Contains(strings.ToLower(str(m, "title")+" "+str(m, "company")+" "+str(m, "sourceText")), q) {
					keep = false
				}
				if keep {
					out = append(out, m)
				}
			}
			out, e = filterRequested(c, k, out)
			if e != nil {
				return e
			}
			return page(c, out)
		})
		g.GET("/"+k+"/:id", func(c echo.Context) error {
			v, e := s.get(c, k, c.Param("id"))
			if e != nil {
				return e
			}
			if k == "approvals" {
				targetKind := map[string]string{"EVIDENCE_USE": "career-evidence", "DOCUMENT_FINALIZE": "versions", "APPLICATION_SUBMIT": "submission-drafts", "CLI_EXECUTE": "runs"}[str(v, "kind")]
				target, e := s.get(c, targetKind, str(v, "targetId"))
				if e != nil {
					return e
				}
				summary := map[string]any{}
				for _, field := range []string{"title", "sourceText", "text", "documentId", "number", "blocks", "documentVersionIds", "workingDirectory", "executable", "arguments", "prompt", "mode", "adapter", "confirmedSubmitted"} {
					if value, exists := target[field]; exists {
						summary[field] = value
					}
				}
				app, e := s.get(c, "applications", str(v, "applicationId"))
				if e != nil {
					return e
				}
				summary["company"] = app["company"]
				summary["applicationTitle"] = app["title"]
				summary["applicationId"] = app["id"]
				v["targetSummary"] = summary
			}
			return ok(c, 200, v)
		})
	}
	g.GET("/operations/:id", func(c echo.Context) error {
		v, e := s.get(c, "operations", c.Param("id"))
		if e != nil {
			return e
		}
		delete(v, "revision")
		return ok(c, 200, v)
	})
	g.POST("/operations/:id/cancel", func(c echo.Context) error {
		v, e := s.get(c, "operations", c.Param("id"))
		if e != nil {
			return e
		}
		if str(v, "status") == "RUNNING" {
			return conflict("이미 공급자가 실행 중입니다. 결과를 확인하세요")
		}
		if str(v, "status") == "QUEUED" {
			var raw []byte
			err := s.q(c).QueryRow(c.Request().Context(), "UPDATE work_queue SET state='CANCELLED' WHERE operation_id=$1 AND owner_id=$2 AND state='QUEUED' RETURNING input", v["id"], owner(c)).Scan(&raw)
			if err != nil {
				return conflict("이미 실행을 시작했습니다")
			}
			var job AIJob
			if err = json.Unmarshal(raw, &job); err != nil {
				return err
			}
			if job.Reservation > 0 {
				if _, err = s.q(c).Exec(c.Request().Context(), "UPDATE billing SET credits=credits+$2,reserved=reserved-$2 WHERE owner_id=$1", owner(c), job.Reservation); err != nil {
					return err
				}
				if err = s.recordLedger(c, "AI_RELEASE", job.Reservation, str(v, "id")); err != nil {
					return err
				}
			}
			if _, err = s.q(c).Exec(c.Request().Context(), "UPDATE resources SET body=body||'{\"status\":\"RELEASED\",\"costMicroCredits\":0}'::jsonb WHERE owner_id=$1 AND kind='ai-usage' AND body->>'operationId'=$2", owner(c), v["id"]); err != nil {
				return err
			}
		}
		if !oneOf(str(v, "status"), "SUCCEEDED", "FAILED", "CANCELLED") {
			v["status"] = "CANCELLED"
			v, e = s.update(c, "operations", v, number(v, "revision"))
			if e != nil {
				return e
			}
		}
		delete(v, "revision")
		return ok(c, 200, v)
	})
	g.GET("/operations/:id/events", s.streamOperation)

	g.POST("/career-evidence", func(c echo.Context) error {
		var in struct {
			Kind         string   `json:"kind"`
			Title        string   `json:"title"`
			SourceText   string   `json:"sourceText"`
			SourceURL    string   `json:"sourceUrl"`
			Skills       []string `json:"skills"`
			SupersedesID string   `json:"supersedesId"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if !oneOf(in.Kind, "RESUME", "GITHUB", "CAREER", "EDUCATION", "SKILL", "PROJECT") || !length(in.Title, 1, 200) || !length(in.SourceText, 1, 100000) || !validURL(in.SourceURL) || !validStrings(in.Skills, 100) {
			return invalid("근거의 종류·길이·출처를 확인하세요")
		}
		if in.SupersedesID != "" {
			if _, e := s.get(c, "career-evidence", in.SupersedesID); e != nil {
				return e
			}
		}
		m := fields(in)
		m["sourceUrl"] = nullable(in.SourceURL)
		m["supersedesId"] = nullable(in.SupersedesID)
		if in.Skills == nil {
			m["skills"] = []string{}
		}
		m["archived"] = false
		m["verificationStatus"] = "USER_PROVIDED"
		m["provenance"] = map[string]any{"sourceId": nil, "projectEvidenceId": nil, "contentHash": hash(in.SourceText), "sourceLocation": nil}
		v, e := s.create(c, "career-evidence", "", m)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.POST("/career-evidence/:id/archive", func(c echo.Context) error {
		var in struct {
			Expected int `json:"expectedRevision"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		v, e := s.get(c, "career-evidence", c.Param("id"))
		if e != nil {
			return e
		}
		v["archived"] = true
		return s.save(c, "career-evidence", v, in.Expected)
	})
	g.POST("/jobs", func(c echo.Context) error {
		var in struct {
			Company      string   `json:"company"`
			Title        string   `json:"title"`
			SourceText   string   `json:"sourceText"`
			SourceURL    string   `json:"sourceUrl"`
			SourceKind   string   `json:"sourceKind"`
			Requirements []string `json:"requirements"`
			Preferred    []string `json:"preferred"`
			Deadline     string   `json:"deadline"`
			Language     string   `json:"language"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if !length(in.Company, 1, 200) || !length(in.Title, 1, 200) || !length(in.SourceText, 1, 100000) || !validURL(in.SourceURL) || !validTime(in.Deadline) || !oneOf(in.SourceKind, "TEXT", "URL", "DOM") || in.SourceKind != "TEXT" && in.SourceURL == "" || !validStrings(in.Requirements, 100) || !validStrings(in.Preferred, 100) {
			return invalid("공고 입력을 확인하세요")
		}
		if in.Language == "" {
			in.Language = "ko"
		}
		if !oneOf(in.Language, "ko", "en") {
			return invalid("language는 ko 또는 en입니다")
		}
		m := fields(in)
		m["sourceUrl"] = nullable(in.SourceURL)
		m["deadline"] = nullable(in.Deadline)
		if in.Requirements == nil {
			m["requirements"] = []string{}
		}
		if in.Preferred == nil {
			m["preferred"] = []string{}
		}
		m["keywords"] = append(append([]string{}, in.Requirements...), in.Preferred...)
		m["risks"] = []string{}
		m["archived"] = false
		v, e := s.create(c, "jobs", "", m)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.PATCH("/jobs/:id", func(c echo.Context) error {
		var in struct {
			Expected     int       `json:"expectedRevision"`
			Company      *string   `json:"company"`
			Title        *string   `json:"title"`
			Requirements *[]string `json:"requirements"`
			Preferred    *[]string `json:"preferred"`
			Deadline     *string   `json:"deadline"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		m, e := s.get(c, "jobs", c.Param("id"))
		if e != nil {
			return e
		}
		if in.Company != nil {
			if !length(*in.Company, 1, 200) {
				return invalid("company 길이 오류")
			}
			m["company"] = *in.Company
		}
		if in.Title != nil {
			if !length(*in.Title, 1, 200) {
				return invalid("title 길이 오류")
			}
			m["title"] = *in.Title
		}
		if in.Requirements != nil {
			if !validStrings(*in.Requirements, 100) {
				return invalid("requirements 오류")
			}
			m["requirements"] = *in.Requirements
		}
		if in.Preferred != nil {
			if !validStrings(*in.Preferred, 100) {
				return invalid("preferred 오류")
			}
			m["preferred"] = *in.Preferred
		}
		if in.Deadline != nil {
			if !validTime(*in.Deadline) {
				return invalid("deadline 오류")
			}
			m["deadline"] = nullable(*in.Deadline)
		}
		return s.save(c, "jobs", m, in.Expected)
	})
	g.POST("/jobs/:id/analyze", func(c echo.Context) error {
		var in struct {
			ApplicationID string     `json:"applicationId"`
			Expected      int        `json:"expectedRevision"`
			EvidenceIDs   []string   `json:"evidenceIds"`
			AI            *AiOptions `json:"ai"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		j, e := s.get(c, "jobs", c.Param("id"))
		if e != nil {
			return e
		}
		if e = s.checkRevision(c, j, in.Expected); e != nil {
			return e
		}
		a, e := s.get(c, "applications", in.ApplicationID)
		if e != nil {
			return e
		}
		if str(a, "jobId") != str(j, "id") {
			return invalid("applicationId의 공고가 다릅니다")
		}
		if in.AI != nil {
			return s.queueAI(c, "JOB_ANALYSIS", in.ApplicationID, AIJob{AI: *in.AI, Prompt: "Analyze the job risks. Return only JSON {\"risks\":[string]}. Do not invent experience. JOB:\n" + str(j, "sourceText"), EvidenceIDs: in.EvidenceIDs, TargetID: str(j, "id"), Expected: in.Expected})
		}
		v, e := s.computeAnalysis(c, j, in.ApplicationID, in.EvidenceIDs, "RULE_BASED", []string{})
		if e != nil {
			return e
		}
		return s.operation(c, "JOB_ANALYSIS", in.ApplicationID, v)
	})
	g.GET("/jobs/:id/analyses", func(c echo.Context) error {
		if _, e := s.get(c, "jobs", c.Param("id")); e != nil {
			return e
		}
		v, e := s.list(c, "analyses", "")
		if e != nil {
			return e
		}
		return page(c, filter(v, "jobId", c.Param("id")))
	})
	s.applicationRoutes(g)
	s.approvalRoutes(g)
	s.contractDocuments(g)
	s.contractProjects(g)
	s.workspaceRoutes(g)
}
func filter(items []any, field, value string) []any {
	out := []any{}
	for _, v := range items {
		if str(v.(map[string]any), field) == value {
			out = append(out, v)
		}
	}
	return out
}
func matching(evs []map[string]any, requirement string) []string {
	out := []string{}
	for _, ev := range evs {
		for _, skill := range stringsAt(ev, "skills") {
			if strings.EqualFold(skill, requirement) {
				out = append(out, str(ev, "id"))
				break
			}
		}
	}
	return out
}
func (s *Server) evidenceFor(c echo.Context, app string, ids []string, approval bool) ([]map[string]any, error) {
	out := []map[string]any{}
	if len(ids) > 100 {
		return nil, invalid("최대 100개 근거를 사용하세요")
	}
	for _, id := range ids {
		e, err := s.get(c, "career-evidence", id)
		if err != nil {
			return nil, err
		}
		if e["archived"] == true {
			return nil, conflict("보관된 근거는 새 작업에 사용할 수 없습니다")
		}
		if str(e, "verificationStatus") == "PENDING" || str(e, "verificationStatus") == "REJECTED" {
			return nil, fail(409, "UNSUPPORTED_CLAIM", "검증되지 않은 프로젝트 근거입니다")
		}
		if approval {
			var found bool
			err = s.q(c).QueryRow(c.Request().Context(), "SELECT EXISTS(SELECT 1 FROM resources WHERE owner_id=$1 AND kind='approvals' AND application_id=$2 AND body->>'kind'='EVIDENCE_USE' AND body->>'targetId'=$3 AND body->>'status'='APPROVED')", owner(c), app, id).Scan(&found)
			if err != nil {
				return nil, err
			}
			if !found {
				return nil, fail(409, "APPROVAL_REQUIRED", "해당 지원에 대한 근거 사용 승인이 필요합니다")
			}
		}
		out = append(out, e)
	}
	return out, nil
}
func (s *Server) applicationRoutes(g *echo.Group) {
	g.POST("/applications/import", func(c echo.Context) error {
		var in struct {
			JobID     string `json:"jobId"`
			Stage     string `json:"stage"`
			AppliedAt string `json:"appliedAt"`
			Notes     string `json:"notes"`
			Confirmed bool   `json:"confirmed"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		at, e := time.Parse(time.RFC3339, in.AppliedAt)
		if e != nil || at.After(time.Now()) || !in.Confirmed || !oneOf(in.Stage, "APPLIED", "SCREENING", "INTERVIEW", "OFFER", "ACCEPTED", "REJECTED", "WITHDRAWN") {
			return invalid("과거 지원일과 완료 확인이 필요합니다")
		}
		j, e := s.get(c, "jobs", in.JobID)
		if e != nil {
			return e
		}
		v, e := s.create(c, "applications", "", map[string]any{"jobId": in.JobID, "company": j["company"], "title": j["title"], "stage": in.Stage, "notes": in.Notes, "appliedAt": at.UTC(), "nextActionAt": nil, "imported": true})
		if e != nil {
			return e
		}
		if _, e = s.q(c).Exec(c.Request().Context(), "UPDATE resources SET application_id=id WHERE id=$1", v["id"]); e != nil {
			return e
		}
		return ok(c, 201, v)
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
		v, e := s.create(c, "applications", "", map[string]any{"jobId": in.JobID, "company": j["company"], "title": j["title"], "stage": "DISCOVERED", "notes": in.Notes, "appliedAt": nil, "nextActionAt": nil})
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
			Stage    *string `json:"stage"`
			Notes    *string `json:"notes"`
			Next     *string `json:"nextActionAt"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		v, e := s.get(c, "applications", c.Param("id"))
		if e != nil {
			return e
		}
		if e = s.checkRevision(c, v, in.Expected); e != nil {
			return e
		}
		st := str(v, "stage")
		if in.Stage != nil && *in.Stage != st {
			next := map[string]string{"DISCOVERED": "PREPARING", "PREPARING": "READY", "APPLIED": "SCREENING", "SCREENING": "INTERVIEW", "INTERVIEW": "OFFER", "OFFER": "ACCEPTED"}
			if oneOf(st, "ACCEPTED", "REJECTED", "WITHDRAWN") || *in.Stage == "APPLIED" || *in.Stage != next[st] && !oneOf(*in.Stage, "REJECTED", "WITHDRAWN") {
				return conflict("허용되지 않는 단계 변경입니다")
			}
			v["stage"] = *in.Stage
		}
		if in.Notes != nil {
			if len(*in.Notes) > 100000 {
				return invalid("notes 길이 초과")
			}
			v["notes"] = *in.Notes
		}
		if in.Next != nil {
			if !validTime(*in.Next) {
				return invalid("nextActionAt 오류")
			}
			v["nextActionAt"] = nullable(*in.Next)
		}
		return s.save(c, "applications", v, in.Expected)
	})
	g.POST("/applications/:id/submission-drafts", func(c echo.Context) error {
		var in struct {
			Expected  int      `json:"expectedRevision"`
			Mode      string   `json:"mode"`
			Adapter   string   `json:"adapter"`
			Versions  []string `json:"documentVersionIds"`
			Confirmed bool     `json:"confirmedSubmitted"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		a, e := s.get(c, "applications", c.Param("id"))
		if e != nil {
			return e
		}
		if e = s.checkRevision(c, a, in.Expected); e != nil {
			return e
		}
		if str(a, "stage") != "READY" {
			return conflict("READY 단계에서 제출을 준비하세요")
		}
		if in.Mode == "ADAPTER" {
			return fail(403, "FEATURE_DISABLED", "채용 사이트 자동 제출이 비활성화되어 있습니다")
		}
		if in.Mode != "MANUAL_RECORD" || !in.Confirmed || len(in.Versions) == 0 {
			return invalid("확정한 문서와 실제 제출 완료 확인이 필요합니다")
		}
		for _, vid := range in.Versions {
			v, e := s.get(c, "versions", vid)
			if e != nil {
				return e
			}
			if str(v, "applicationId") != str(a, "id") {
				return invalid("다른 지원의 문서입니다")
			}
			d, e := s.get(c, "documents", str(v, "documentId"))
			if e != nil {
				return e
			}
			if str(d, "finalizedVersionId") != vid || str(d, "status") != "FINALIZED" {
				return fail(422, "DOCUMENT_NOT_FINALIZED", "확정 문서가 필요합니다")
			}
		}
		m := map[string]any{"applicationId": a["id"], "applicationRevision": a["revision"], "mode": in.Mode, "adapter": nullable(in.Adapter), "documentVersionIds": in.Versions, "confirmedSubmitted": true}
		m["payloadHash"] = hashJSON(m)
		v, e := s.create(c, "submission-drafts", str(a, "id"), m)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.POST("/applications/:id/submissions", func(c echo.Context) error {
		var in struct {
			Expected   int    `json:"expectedRevision"`
			DraftID    string `json:"draftId"`
			ApprovalID string `json:"approvalId"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		a, e := s.get(c, "applications", c.Param("id"))
		if e != nil {
			return e
		}
		if e = s.checkRevision(c, a, in.Expected); e != nil {
			return e
		}
		d, e := s.get(c, "submission-drafts", in.DraftID)
		if e != nil {
			return e
		}
		if str(a, "stage") != "READY" || str(d, "applicationId") != str(a, "id") || number(d, "applicationRevision") != in.Expected {
			return fail(409, "APPROVAL_STALE", "지원 정보가 변경되었습니다")
		}
		for _, vid := range stringsAt(d, "documentVersionIds") {
			v, e := s.get(c, "versions", vid)
			if e != nil {
				return e
			}
			doc, e := s.get(c, "documents", str(v, "documentId"))
			if e != nil {
				return e
			}
			if str(doc, "finalizedVersionId") != vid || str(doc, "status") != "FINALIZED" {
				return fail(409, "APPROVAL_STALE", "문서가 변경되었습니다")
			}
		}
		if e = s.consumeApproval(c, in.ApprovalID, "APPLICATION_SUBMIT", str(a, "id"), d); e != nil {
			return e
		}
		v, e := s.create(c, "submissions", str(a, "id"), map[string]any{"applicationId": a["id"], "mode": d["mode"], "adapter": d["adapter"], "status": "SUCCEEDED", "documentVersionIds": d["documentVersionIds"], "approvalId": in.ApprovalID, "receiptUrl": nil, "errorCode": nil})
		if e != nil {
			return e
		}
		a["stage"] = "APPLIED"
		a["appliedAt"] = time.Now().UTC()
		if _, e = s.update(c, "applications", a, in.Expected); e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.GET("/applications/:id/submissions", func(c echo.Context) error {
		if _, e := s.get(c, "applications", c.Param("id")); e != nil {
			return e
		}
		v, e := s.list(c, "submissions", c.Param("id"))
		if e != nil {
			return e
		}
		return page(c, v)
	})
	g.GET("/applications/:id/checklist", func(c echo.Context) error {
		a, e := s.get(c, "applications", c.Param("id"))
		if e != nil {
			return e
		}
		return ok(c, 200, map[string]any{"automationEnabled": false, "items": []any{map[string]any{"key": "review", "label": "공고와 지원 조건 검토", "completed": str(a, "stage") != "DISCOVERED"}, map[string]any{"key": "submit", "label": "채용 사이트에서 직접 제출하고 기록", "completed": a["appliedAt"] != nil}}})
	})
}
func hashJSON(v any) string {
	b, _ := json.Marshal(v)
	var canonical any
	if json.Unmarshal(b, &canonical) == nil {
		b, _ = json.Marshal(canonical)
	}
	return hash(string(b))
}
func targetHash(v map[string]any) string {
	m := map[string]any{}
	for k, x := range v {
		if !oneOf(k, "revision", "createdAt", "updatedAt") {
			m[k] = x
		}
	}
	return hashJSON(m)
}
func (s *Server) approvalRoutes(g *echo.Group) {
	g.POST("/approvals", func(c echo.Context) error {
		var in struct {
			Kind           string `json:"kind"`
			ApplicationID  string `json:"applicationId"`
			TargetID       string `json:"targetId"`
			TargetRevision *int   `json:"targetRevision"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if _, e := s.get(c, "applications", in.ApplicationID); e != nil {
			return e
		}
		kind := map[string]string{"EVIDENCE_USE": "career-evidence", "DOCUMENT_FINALIZE": "versions", "APPLICATION_SUBMIT": "submission-drafts", "CLI_EXECUTE": "runs"}[in.Kind]
		if kind == "" {
			return invalid("승인 종류 오류")
		}
		target, e := s.get(c, kind, in.TargetID)
		if e != nil {
			return e
		}
		if kind != "career-evidence" && str(target, "applicationId") != in.ApplicationID {
			return invalid("승인 대상 지원이 다릅니다")
		}
		if target["archived"] == true {
			return conflict("보관된 근거입니다")
		}
		var revision any
		if !immutable(kind) {
			revision = target["revision"]
			if in.TargetRevision != nil && *in.TargetRevision != number(target, "revision") {
				return fail(409, "APPROVAL_STALE", "대상이 변경되었습니다")
			}
		}
		var expires any = time.Now().UTC().Add(24 * time.Hour)
		if kind == "career-evidence" {
			expires = nil
		}
		m := map[string]any{"kind": in.Kind, "applicationId": in.ApplicationID, "targetId": in.TargetID, "targetRevision": revision, "payloadHash": targetHash(target), "status": "PENDING", "expiresAt": expires, "decidedAt": nil, "consumedAt": nil}
		v, e := s.create(c, "approvals", in.ApplicationID, m)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.POST("/approvals/:id/decision", func(c echo.Context) error {
		var in struct {
			Expected int    `json:"expectedRevision"`
			Decision string `json:"decision"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		a, e := s.get(c, "approvals", c.Param("id"))
		if e != nil {
			return e
		}
		if e = s.checkRevision(c, a, in.Expected); e != nil {
			return e
		}
		if !oneOf(in.Decision, "APPROVED", "DENIED") {
			return invalid("승인 결정 오류")
		}
		if str(a, "status") != "PENDING" {
			return conflict("이미 결정한 승인입니다")
		}
		if at, err := time.Parse(time.RFC3339Nano, str(a, "expiresAt")); err == nil && at.Before(time.Now()) {
			return fail(409, "APPROVAL_STALE", "승인이 만료되었습니다")
		}
		a["status"] = in.Decision
		a["decidedAt"] = time.Now().UTC()
		return s.save(c, "approvals", a, in.Expected)
	})
}
func (s *Server) consumeApproval(c echo.Context, approvalID, kind, app string, target map[string]any) error {
	a, e := s.get(c, "approvals", approvalID)
	if e != nil {
		return e
	}
	if str(a, "kind") != kind || str(a, "applicationId") != app || str(a, "targetId") != str(target, "id") || str(a, "status") != "APPROVED" {
		return fail(409, "APPROVAL_REQUIRED", "정확한 대상의 승인이 필요합니다")
	}
	if str(a, "payloadHash") != targetHash(target) {
		return fail(409, "APPROVAL_STALE", "승인 대상이 변경되었습니다")
	}
	if at, err := time.Parse(time.RFC3339Nano, str(a, "expiresAt")); err == nil && at.Before(time.Now()) {
		return fail(409, "APPROVAL_STALE", "승인이 만료되었습니다")
	}
	a["status"] = "CONSUMED"
	a["consumedAt"] = time.Now().UTC()
	_, e = s.update(c, "approvals", a, number(a, "revision"))
	return e
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
	_, e := time.Parse(time.RFC3339, value)
	return e == nil
}

func (s *Server) computeAnalysis(c echo.Context, j map[string]any, app string, ids []string, method string, risks []string) (map[string]any, error) {
	evs, e := s.evidenceFor(c, app, ids, true)
	if e != nil {
		return nil, e
	}
	matched := []any{}
	missing, preferred := []string{}, []string{}
	for _, r := range stringsAt(j, "requirements") {
		ids := matching(evs, r)
		if len(ids) > 0 {
			matched = append(matched, map[string]any{"requirement": r, "evidenceIds": ids})
		} else {
			missing = append(missing, r)
		}
	}
	for _, r := range stringsAt(j, "preferred") {
		if len(matching(evs, r)) == 0 {
			preferred = append(preferred, r)
		}
	}
	var score any
	requirements := stringsAt(j, "requirements")
	if len(requirements) > 0 {
		score = len(matched) * 100 / len(requirements)
	}
	m := map[string]any{"applicationId": app, "jobId": j["id"], "jobRevision": j["revision"], "evidenceIds": ids, "matched": matched, "missing": missing, "preferredMissing": preferred, "risks": risks, "fitScore": score, "method": method}
	if ids == nil {
		m["evidenceIds"] = []string{}
	}
	v, e := s.create(c, "analyses", app, m)
	if e != nil {
		return nil, e
	}
	return v, nil
}
