package main

import (
	"encoding/json"
	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"strings"
)

type EvidenceRef struct {
	EvidenceID string `json:"evidenceId"`
	Start      int    `json:"start"`
	End        int    `json:"end"`
}
type BlockInput struct {
	ID           string        `json:"id"`
	Text         string        `json:"text"`
	EvidenceRefs []EvidenceRef `json:"evidenceRefs"`
}
type TipTapNode struct {
	Type    string         `json:"type"`
	Attrs   map[string]any `json:"attrs,omitempty"`
	Text    string         `json:"text,omitempty"`
	Content []TipTapNode   `json:"content,omitempty"`
	Marks   []TipTapMark   `json:"marks,omitempty"`
}
type TipTapMark struct {
	Type  string         `json:"type"`
	Attrs map[string]any `json:"attrs,omitempty"`
}

func checkContent(root TipTapNode, blocks []BlockInput) error {
	if root.Type != "doc" || len(blocks) > 200 || len(blocks) == 0 {
		return invalid("문서 블록은 1~200개입니다")
	}
	found := map[string]string{}
	var walk func(TipTapNode, int) (string, error)
	walk = func(n TipTapNode, depth int) (string, error) {
		if depth > 20 {
			return "", invalid("문서 중첩이 너무 깊습니다")
		}
		if !oneOf(n.Type, "doc", "paragraph", "heading", "bulletList", "orderedList", "listItem", "text", "hardBreak") {
			return "", invalid("허용하지 않는 문서 노드입니다")
		}
		for k, v := range n.Attrs {
			if !oneOf(k, "blockId", "level", "start") {
				return "", invalid("허용하지 않는 노드 속성입니다")
			}
			if k == "level" {
				n, ok := v.(float64)
				if !ok || n < 1 || n > 6 || n != float64(int(n)) {
					return "", invalid("제목 level 오류")
				}
			}
		}
		for _, m := range n.Marks {
			if !oneOf(m.Type, "bold", "italic", "strike", "code", "link") {
				return "", invalid("허용하지 않는 텍스트 mark입니다")
			}
			for k, v := range m.Attrs {
				if m.Type != "link" || !oneOf(k, "href", "target", "rel", "class") {
					return "", invalid("mark 속성 오류")
				}
				if k == "href" {
					href, ok := v.(string)
					if !ok || !validURL(href) || href == "" {
						return "", invalid("링크 URL 오류")
					}
				}
			}
		}
		if n.Type == "text" {
			if len(n.Content) > 0 || len(n.Attrs) > 0 || n.Text == "" {
				return "", invalid("텍스트 노드 오류")
			}
			return n.Text, nil
		}
		if n.Text != "" {
			return "", invalid("숨겨진 텍스트를 허용하지 않습니다")
		}
		text := ""
		for _, child := range n.Content {
			if oneOf(n.Type, "paragraph", "heading") && !oneOf(child.Type, "text", "hardBreak") {
				return "", invalid("블록 내부에는 텍스트만 허용합니다")
			}
			if oneOf(n.Type, "doc", "listItem", "bulletList", "orderedList") && child.Type == "text" {
				return "", invalid("블록 없이 텍스트를 사용할 수 없습니다")
			}
			t, e := walk(child, depth+1)
			if e != nil {
				return "", e
			}
			text += t
		}
		if n.Type == "hardBreak" {
			return "\n", nil
		}
		if oneOf(n.Type, "paragraph", "heading") {
			id, ok := n.Attrs["blockId"].(string)
			if !ok || id == "" {
				return "", invalid("각 텍스트 블록에 blockId가 필요합니다")
			}
			if _, exists := found[id]; exists {
				return "", invalid("중복 blockId입니다")
			}
			found[id] = text
		}
		return text, nil
	}
	if _, e := walk(root, 0); e != nil {
		return e
	}
	if len(found) != len(blocks) {
		return invalid("content와 blocks가 일치하지 않습니다")
	}
	seen := map[string]bool{}
	for _, b := range blocks {
		if !length(b.Text, 1, 100000) || seen[b.ID] || found[b.ID] != b.Text {
			return invalid("블록의 텍스트가 문서와 일치하지 않습니다")
		}
		seen[b.ID] = true
	}
	return nil
}
func (s *Server) validatedBlocks(c echo.Context, app string, content TipTapNode, blocks []BlockInput) ([]any, error) {
	if e := checkContent(content, blocks); e != nil {
		return nil, e
	}
	out := []any{}
	for _, b := range blocks {
		supported := false
		for _, ref := range b.EvidenceRefs {
			ev, e := s.get(c, "career-evidence", ref.EvidenceID)
			if e != nil {
				return nil, e
			}
			runes := []rune(str(ev, "sourceText"))
			if ref.Start < 0 || ref.End <= ref.Start || ref.End > len(runes) {
				return nil, invalid("근거 원문 위치가 유효하지 않습니다")
			}
			if string(runes[ref.Start:ref.End]) == b.Text {
				supported = true
			}
		}
		status := "NEEDS_REVIEW"
		if len(b.EvidenceRefs) > 0 {
			status = "UNSUPPORTED"
		}
		if supported {
			status = "SUPPORTED"
		}
		m := fields(b)
		if b.EvidenceRefs == nil {
			m["evidenceRefs"] = []any{}
		}
		m["claimStatus"] = status
		out = append(out, m)
	}
	return out, nil
}
func (s *Server) version(c echo.Context, d map[string]any, expected int, content TipTapNode, blocks []BlockInput, note string) (map[string]any, error) {
	if e := s.checkRevision(c, d, expected); e != nil {
		return nil, e
	}
	if str(d, "status") == "ARCHIVED" {
		return nil, conflict("보관한 문서입니다")
	}
	validated, e := s.validatedBlocks(c, str(d, "applicationId"), content, blocks)
	if e != nil {
		return nil, e
	}
	supported := 0
	issues := []any{}
	text := ""
	for _, v := range validated {
		m := v.(map[string]any)
		text += str(m, "text") + "\n"
		if str(m, "claimStatus") == "SUPPORTED" {
			supported++
		} else {
			issues = append(issues, map[string]any{"code": "UNSUPPORTED_CLAIM", "severity": "ERROR", "blockId": m["id"], "message": "원문 근거를 보완하세요"})
		}
	}
	a, e := s.get(c, "applications", str(d, "applicationId"))
	if e != nil {
		return nil, e
	}
	j, e := s.get(c, "jobs", str(a, "jobId"))
	if e != nil {
		return nil, e
	}
	var fit any
	keywords := append(stringsAt(j, "requirements"), stringsAt(j, "preferred")...)
	if len(keywords) > 0 {
		matches := 0
		for _, k := range keywords {
			if strings.Contains(strings.ToLower(text), strings.ToLower(k)) {
				matches++
			}
		}
		fit = matches * 100 / len(keywords)
	}
	var count int
	e = s.q(c).QueryRow(c.Request().Context(), "SELECT count(*) FROM resources WHERE owner_id=$1 AND kind='versions' AND body->>'documentId'=$2", owner(c), d["id"]).Scan(&count)
	if e != nil {
		return nil, e
	}
	quality := map[string]any{"jobFit": fit, "evidenceFidelity": supported * 100 / len(blocks), "readability": nil, "ats": fit, "method": "RULE_BASED", "issues": issues}
	v, e := s.create(c, "versions", str(d, "applicationId"), map[string]any{"documentId": d["id"], "applicationId": d["applicationId"], "number": count + 1, "content": content, "blocks": validated, "changeNote": note, "quality": quality})
	if e != nil {
		return nil, e
	}
	d["latestVersionId"] = v["id"]
	d["finalizedVersionId"] = nil
	d["status"] = "DRAFT"
	updated, e := s.update(c, "documents", d, expected)
	if e != nil {
		return nil, e
	}
	return map[string]any{"document": updated, "version": v}, nil
}
func (s *Server) contractDocuments(g *echo.Group) {
	g.POST("/documents", func(c echo.Context) error {
		var in struct {
			ApplicationID string `json:"applicationId"`
			Title         string `json:"title"`
			Kind          string `json:"kind"`
			Template      string `json:"template"`
			Language      string `json:"language"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if !length(in.Title, 1, 200) || !oneOf(in.Kind, "RESUME", "PORTFOLIO", "COVER_LETTER") || !oneOf(in.Template, "CLASSIC", "MODERN", "COMPACT") {
			return invalid("문서 입력 오류")
		}
		if in.Language == "" {
			in.Language = "ko"
		}
		if !oneOf(in.Language, "ko", "en") {
			return invalid("language 오류")
		}
		if _, e := s.get(c, "applications", in.ApplicationID); e != nil {
			return e
		}
		m := fields(in)
		m["status"] = "DRAFT"
		m["latestVersionId"] = nil
		m["finalizedVersionId"] = nil
		v, e := s.create(c, "documents", in.ApplicationID, m)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.PATCH("/documents/:id", func(c echo.Context) error {
		var in struct {
			Expected int     `json:"expectedRevision"`
			Title    *string `json:"title"`
			Template *string `json:"template"`
			Language *string `json:"language"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		d, e := s.get(c, "documents", c.Param("id"))
		if e != nil {
			return e
		}
		if in.Title != nil {
			if !length(*in.Title, 1, 200) {
				return invalid("title 오류")
			}
			d["title"] = *in.Title
		}
		if in.Template != nil {
			if !oneOf(*in.Template, "CLASSIC", "MODERN", "COMPACT") {
				return invalid("template 오류")
			}
			d["template"] = *in.Template
			d["status"] = "DRAFT"
			d["finalizedVersionId"] = nil
		}
		if in.Language != nil {
			if !oneOf(*in.Language, "ko", "en") {
				return invalid("language 오류")
			}
			d["language"] = *in.Language
			d["status"] = "DRAFT"
			d["finalizedVersionId"] = nil
		}
		return s.save(c, "documents", d, in.Expected)
	})
	g.GET("/documents/:id/versions", func(c echo.Context) error {
		d, e := s.get(c, "documents", c.Param("id"))
		if e != nil {
			return e
		}
		v, e := s.list(c, "versions", str(d, "applicationId"))
		if e != nil {
			return e
		}
		return page(c, filter(v, "documentId", c.Param("id")))
	})
	g.GET("/documents/:id/versions/:versionId", func(c echo.Context) error {
		v, e := s.documentVersion(c)
		if e != nil {
			return e
		}
		return ok(c, 200, v)
	})
	g.POST("/documents/:id/versions", func(c echo.Context) error {
		var in struct {
			Expected int          `json:"expectedRevision"`
			Content  TipTapNode   `json:"content"`
			Blocks   []BlockInput `json:"blocks"`
			Note     string       `json:"changeNote"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		d, e := s.get(c, "documents", c.Param("id"))
		if e != nil {
			return e
		}
		v, e := s.version(c, d, in.Expected, in.Content, in.Blocks, in.Note)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.POST("/documents/:id/generate", func(c echo.Context) error {
		var in struct {
			Expected    int        `json:"expectedRevision"`
			EvidenceIDs []string   `json:"evidenceIds"`
			AnalysisID  string     `json:"analysisId"`
			AI          *AiOptions `json:"ai"`
			Language    string     `json:"language"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		d, e := s.get(c, "documents", c.Param("id"))
		if e != nil {
			return e
		}
		if e = s.checkRevision(c, d, in.Expected); e != nil {
			return e
		}
		if in.AnalysisID != "" {
			analysis, e := s.get(c, "analyses", in.AnalysisID)
			if e != nil {
				return e
			}
			if str(analysis, "applicationId") != str(d, "applicationId") {
				return invalid("다른 지원의 분석입니다")
			}
		}
		if in.AI != nil {
			return s.queueAI(c, "DOCUMENT_GENERATE", str(d, "applicationId"), AIJob{AI: *in.AI, Prompt: "Draft a document using only the provided evidence. Preserve evidence text where possible. Return plain paragraphs.", EvidenceIDs: in.EvidenceIDs, DocumentID: str(d, "id"), Expected: in.Expected})
		}
		evs, e := s.evidenceFor(c, str(d, "applicationId"), in.EvidenceIDs, true)
		if e != nil {
			return e
		}
		if len(evs) == 0 {
			return invalid("근거를 선택하세요")
		}
		blocks := []BlockInput{}
		content := TipTapNode{Type: "doc", Content: []TipTapNode{}}
		for _, ev := range evs {
			b := BlockInput{ID: uuid.NewString(), Text: str(ev, "sourceText"), EvidenceRefs: []EvidenceRef{{EvidenceID: str(ev, "id"), Start: 0, End: len([]rune(str(ev, "sourceText")))}}}
			blocks = append(blocks, b)
			content.Content = append(content.Content, TipTapNode{Type: "paragraph", Attrs: map[string]any{"blockId": b.ID}, Content: []TipTapNode{{Type: "text", Text: b.Text}}})
		}
		v, e := s.version(c, d, in.Expected, content, blocks, "원본 근거 발췌")
		if e != nil {
			return e
		}
		return s.operation(c, "DOCUMENT_GENERATE", str(d, "applicationId"), v)
	})
	g.POST("/documents/:id/finalize", func(c echo.Context) error {
		var in struct {
			Expected   int    `json:"expectedRevision"`
			VersionID  string `json:"versionId"`
			ApprovalID string `json:"approvalId"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		d, e := s.get(c, "documents", c.Param("id"))
		if e != nil {
			return e
		}
		if e = s.checkRevision(c, d, in.Expected); e != nil {
			return e
		}
		v, e := s.get(c, "versions", in.VersionID)
		if e != nil {
			return e
		}
		if str(v, "documentId") != str(d, "id") || str(d, "latestVersionId") != in.VersionID {
			return fail(409, "APPROVAL_STALE", "현재 문서 버전이 아닙니다")
		}
		for _, raw := range v["blocks"].([]any) {
			block := raw.(map[string]any)
			if str(block, "claimStatus") != "SUPPORTED" {
				return fail(409, "UNSUPPORTED_CLAIM", "원문 근거를 확인할 수 없는 문장입니다")
			}
			ids := []string{}
			for _, r := range block["evidenceRefs"].([]any) {
				ids = append(ids, str(r.(map[string]any), "evidenceId"))
			}
			if _, e = s.evidenceFor(c, str(d, "applicationId"), ids, true); e != nil {
				return e
			}
		}
		if e = s.consumeApproval(c, in.ApprovalID, "DOCUMENT_FINALIZE", str(d, "applicationId"), v); e != nil {
			return e
		}
		d["status"] = "FINALIZED"
		d["finalizedVersionId"] = v["id"]
		return s.save(c, "documents", d, in.Expected)
	})
	g.POST("/documents/:id/archive", func(c echo.Context) error {
		var in struct {
			Expected int `json:"expectedRevision"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		d, e := s.get(c, "documents", c.Param("id"))
		if e != nil {
			return e
		}
		d["status"] = "ARCHIVED"
		return s.save(c, "documents", d, in.Expected)
	})
	g.POST("/documents/:id/review", func(c echo.Context) error {
		var in struct {
			VersionID string `json:"versionId"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		v, e := s.get(c, "versions", in.VersionID)
		if e != nil {
			return e
		}
		if str(v, "documentId") != c.Param("id") {
			return invalid("다른 문서 버전입니다")
		}
		return ok(c, 200, map[string]any{"quality": v["quality"], "blocks": v["blocks"]})
	})
	s.revisionRoutes(g)
	s.exportRoutes(g)
	s.draftRoutes(g)
}
func (s *Server) documentVersion(c echo.Context) (map[string]any, error) {
	v, e := s.get(c, "versions", c.Param("versionId"))
	if e != nil {
		return nil, e
	}
	if str(v, "documentId") != c.Param("id") {
		return nil, fail(404, "NOT_FOUND", "문서 버전이 없습니다")
	}
	return v, nil
}
func (s *Server) exportRoutes(g *echo.Group) {
	g.POST("/documents/:id/exports", func(c echo.Context) error {
		var in struct {
			VersionID string `json:"versionId"`
			Format    string `json:"format"`
			Renderer  string `json:"rendererVersion"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		d, e := s.get(c, "documents", c.Param("id"))
		if e != nil {
			return e
		}
		if str(d, "status") != "FINALIZED" || str(d, "finalizedVersionId") != in.VersionID {
			return fail(422, "DOCUMENT_NOT_FINALIZED", "확정 버전만 출력할 수 있습니다")
		}
		if !oneOf(in.Format, "PDF", "DOCX") || !length(in.Renderer, 1, 100) {
			return invalid("출력 형식과 렌더러를 확인하세요")
		}
		v, e := s.get(c, "versions", in.VersionID)
		if e != nil {
			return e
		}
		out, e := s.create(c, "exports", str(d, "applicationId"), map[string]any{"documentId": d["id"], "versionId": v["id"], "format": in.Format, "template": d["template"], "language": d["language"], "content": v["content"], "blocks": v["blocks"], "contentHash": hashJSON(v["content"]), "rendererVersion": in.Renderer, "status": "READY_TO_RENDER"})
		if e != nil {
			return e
		}
		return ok(c, 201, out)
	})
	g.POST("/documents/:id/exports/:exportId/result", func(c echo.Context) error {
		var in struct {
			SHA        string `json:"sha256"`
			Bytes      int64  `json:"byteLength"`
			Pages      *int   `json:"pageCount"`
			Validation struct {
				Korean bool `json:"koreanText"`
				Links  bool `json:"links"`
				ATS    bool `json:"atsText"`
			} `json:"validation"`
			Status    string `json:"status"`
			ErrorCode string `json:"errorCode"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		v, e := s.get(c, "exports", c.Param("exportId"))
		if e != nil {
			return e
		}
		if str(v, "documentId") != c.Param("id") {
			return fail(404, "NOT_FOUND", "출력이 없습니다")
		}
		if str(v, "status") != "READY_TO_RENDER" {
			return conflict("이미 결과가 기록되었습니다")
		}
		if !oneOf(in.Status, "SUCCEEDED", "FAILED") || in.Status == "SUCCEEDED" && (len(in.SHA) != 64 || in.Bytes <= 0 || !in.Validation.Korean || !in.Validation.Links || !in.Validation.ATS) {
			return invalid("파일과 출력 검증 결과를 확인하세요")
		}
		for k, x := range fields(in) {
			v[k] = x
		}
		return s.save(c, "exports", v, number(v, "revision"))
	})
	g.GET("/documents/:id/exports", func(c echo.Context) error {
		d, e := s.get(c, "documents", c.Param("id"))
		if e != nil {
			return e
		}
		v, e := s.list(c, "exports", str(d, "applicationId"))
		if e != nil {
			return e
		}
		return page(c, filter(v, "documentId", c.Param("id")))
	})
}
func (s *Server) draftRoutes(g *echo.Group) {
	g.GET("/documents/:id/drafts", func(c echo.Context) error {
		d, e := s.get(c, "documents", c.Param("id"))
		if e != nil {
			return e
		}
		v, e := s.list(c, "drafts", str(d, "applicationId"))
		if e != nil {
			return e
		}
		return page(c, filter(v, "documentId", c.Param("id")))
	})
	g.POST("/documents/:id/drafts", func(c echo.Context) error {
		var in struct {
			ID      string       `json:"id"`
			Base    int          `json:"baseDocumentRevision"`
			Content TipTapNode   `json:"content"`
			Blocks  []BlockInput `json:"blocks"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		d, e := s.get(c, "documents", c.Param("id"))
		if e != nil {
			return e
		}
		if !validID(in.ID) || in.Base < 1 {
			return invalid("draft id와 baseDocumentRevision이 필요합니다")
		}
		if _, e = s.validatedBlocks(c, str(d, "applicationId"), in.Content, in.Blocks); e != nil {
			return e
		}
		v, e := s.createWithID(c, "drafts", str(d, "applicationId"), in.ID, map[string]any{"documentId": d["id"], "applicationId": d["applicationId"], "baseDocumentRevision": in.Base, "content": in.Content, "blocks": in.Blocks})
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.PATCH("/documents/:id/drafts/:draftId", func(c echo.Context) error {
		var in struct {
			Expected int          `json:"expectedRevision"`
			Base     int          `json:"baseDocumentRevision"`
			Content  TipTapNode   `json:"content"`
			Blocks   []BlockInput `json:"blocks"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		d, e := s.get(c, "drafts", c.Param("draftId"))
		if e != nil {
			return e
		}
		if str(d, "documentId") != c.Param("id") {
			return fail(404, "NOT_FOUND", "초안이 없습니다")
		}
		if in.Base < 1 {
			return invalid("baseDocumentRevision 오류")
		}
		if _, e = s.validatedBlocks(c, str(d, "applicationId"), in.Content, in.Blocks); e != nil {
			return e
		}
		d["content"] = in.Content
		d["blocks"] = in.Blocks
		d["baseDocumentRevision"] = in.Base
		return s.save(c, "drafts", d, in.Expected)
	})
}
func (s *Server) createWithID(c echo.Context, kind, app, id string, m map[string]any) (map[string]any, error) {
	var exists bool
	e := s.q(c).QueryRow(c.Request().Context(), "SELECT EXISTS(SELECT 1 FROM resources WHERE id=$1)", id).Scan(&exists)
	if e != nil {
		return nil, e
	}
	if exists {
		return nil, conflict("이미 존재하는 리소스 ID입니다")
	}
	raw, e := json.Marshal(m)
	if e != nil {
		return nil, e
	}
	var application any
	if app != "" {
		application = app
	}
	v, e := scanResource(s.q(c).QueryRow(c.Request().Context(), "INSERT INTO resources(id,owner_id,kind,application_id,body) VALUES($1,$2,$3,$4,$5) RETURNING id,body,revision,created_at,updated_at", id, owner(c), kind, application, raw))
	if e != nil {
		return nil, e
	}
	return v, nil
}
func decodeMap(m map[string]any, v any) error {
	b, e := json.Marshal(m)
	if e != nil {
		return e
	}
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.DisallowUnknownFields()
	if e = d.Decode(v); e != nil {
		return invalid("허용하지 않는 payload입니다")
	}
	return nil
}
