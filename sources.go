package main

import (
	"archive/zip"
	"bytes"
	"github.com/labstack/echo/v4"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

func (s *Server) sourceRoutes(g *echo.Group) {
	g.POST("/sources", func(c echo.Context) error {
		file, e := c.FormFile("file")
		if e != nil {
			return invalid("file이 필요합니다")
		}
		if file.Size > 20<<20 {
			return fail(413, "PAYLOAD_TOO_LARGE", "파일은 최대 20MiB입니다")
		}
		r, e := file.Open()
		if e != nil {
			return e
		}
		defer r.Close()
		body, e := io.ReadAll(io.LimitReader(r, 20<<20+1))
		if e != nil {
			return e
		}
		if len(body) > 20<<20 {
			return fail(413, "PAYLOAD_TOO_LARGE", "파일 크기 초과")
		}
		ext := strings.ToLower(filepath.Ext(file.Filename))
		mimeType := ""
		switch ext {
		case ".pdf":
			if bytes.HasPrefix(body, []byte("%PDF-")) {
				mimeType = "application/pdf"
			}
		case ".docx":
			z, e := zip.NewReader(bytes.NewReader(body), int64(len(body)))
			if e == nil {
				for _, f := range z.File {
					if f.Name == "word/document.xml" && f.UncompressedSize64 < 20<<20 {
						mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
					}
				}
			}
		case ".txt", ".md":
			if utf8.Valid(body) && !bytes.Contains(body, []byte{0}) {
				mimeType = "text/plain"
				if ext == ".md" {
					mimeType = "text/markdown"
				}
			}
		}
		if mimeType == "" {
			return invalid("지원하는 파일 형식이 아닙니다")
		}
		if c.FormValue("kind") == "" {
			return invalid("kind가 필요합니다")
		}
		v, e := s.create(c, "sources", "", map[string]any{"fileName": filepath.Base(file.Filename), "mimeType": mimeType, "size": len(body), "sha256": hash(string(body)), "status": "UPLOADED"})
		if e != nil {
			return e
		}
		if _, e = s.q(c).Exec(c.Request().Context(), "INSERT INTO source_files(id,owner_id,content) VALUES($1,$2,$3)", v["id"], owner(c), body); e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.GET("/sources/:id", func(c echo.Context) error {
		v, e := s.get(c, "sources", c.Param("id"))
		if e != nil {
			return e
		}
		return ok(c, 200, v)
	})
	g.GET("/sources/:id/content", func(c echo.Context) error {
		v, e := s.get(c, "sources", c.Param("id"))
		if e != nil {
			return e
		}
		var body []byte
		if e = s.q(c).QueryRow(c.Request().Context(), "SELECT content FROM source_files WHERE owner_id=$1 AND id=$2", owner(c), v["id"]).Scan(&body); e != nil {
			return e
		}
		c.Response().Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": str(v, "fileName")}))
		return c.Blob(http.StatusOK, str(v, "mimeType"), body)
	})
	g.DELETE("/sources/:id", func(c echo.Context) error {
		if _, e := s.get(c, "sources", c.Param("id")); e != nil {
			return e
		}
		var used bool
		e := s.q(c).QueryRow(c.Request().Context(), "SELECT EXISTS(SELECT 1 FROM resources WHERE owner_id=$1 AND kind='career-evidence' AND body->'provenance'->>'sourceId'=$2)", owner(c), c.Param("id")).Scan(&used)
		if e != nil {
			return e
		}
		if used {
			return conflict("인용 중인 원본입니다")
		}
		if _, e = s.q(c).Exec(c.Request().Context(), "DELETE FROM source_files WHERE owner_id=$1 AND id=$2", owner(c), c.Param("id")); e != nil {
			return e
		}
		if _, e = s.q(c).Exec(c.Request().Context(), "DELETE FROM resources WHERE owner_id=$1 AND id=$2 AND kind='sources'", owner(c), c.Param("id")); e != nil {
			return e
		}
		return empty(c)
	})
	g.POST("/career-evidence/import", func(c echo.Context) error {
		var in struct {
			SourceID  string `json:"sourceId"`
			Text      string `json:"text"`
			SourceURL string `json:"sourceUrl"`
			Hash      string `json:"contentHash"`
			Format    string `json:"format"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if !oneOf(in.Format, "TEXT", "MARKDOWN", "PDF", "DOCX", "GITHUB") || !validURL(in.SourceURL) {
			return invalid("입력 형식 오류")
		}
		if in.SourceID != "" {
			source, e := s.get(c, "sources", in.SourceID)
			if e != nil {
				return e
			}
			if in.Hash != "" && in.Hash != str(source, "sha256") {
				return invalid("원본 파일 해시가 다릅니다")
			}
		}
		if in.Text == "" && in.SourceID != "" {
			source, e := s.get(c, "sources", in.SourceID)
			if e != nil {
				return e
			}
			var raw []byte
			if e = s.q(c).QueryRow(c.Request().Context(), "SELECT content FROM source_files WHERE owner_id=$1 AND id=$2", owner(c), in.SourceID).Scan(&raw); e != nil {
				return e
			}
			in.Text, e = extractFile(c.Request().Context(), str(source, "mimeType"), raw)
			if e != nil {
				return e
			}
		}
		if in.Text == "" && in.Format == "GITHUB" {
			var e error
			in.Text, e = s.githubSource(c, in.SourceURL)
			if e != nil {
				return e
			}
		}
		if strings.TrimSpace(in.Text) == "" {
			v, e := s.create(c, "operations", "", map[string]any{"type": "EVIDENCE_IMPORT", "applicationId": nil, "status": "NEEDS_INPUT", "progress": nil, "result": nil, "error": nil, "inputRequest": map[string]any{"code": "TEXT_REQUIRED", "message": "읽을 수 있는 원문 텍스트가 필요합니다", "fields": []any{map[string]string{"name": "text", "label": "추출된 원문", "type": "TEXT"}}}, "sourceId": nullable(in.SourceID)})
			if e != nil {
				return e
			}
			delete(v, "revision")
			return ok(c, 202, v)
		}
		if !length(in.Text, 1, 100000) {
			return invalid("원문 길이 오류")
		}
		out, e := s.importText(c, in.Text, in.SourceID, in.SourceURL)
		if e != nil {
			return e
		}
		return s.operation(c, "EVIDENCE_IMPORT", "", map[string]any{"evidence": out, "warnings": []any{map[string]any{"code": "REVIEW_REQUIRED", "message": "원문 분리 결과와 기술 항목을 확인하세요", "sourceLocation": nil}}})
	})
	g.POST("/operations/:id/input", func(c echo.Context) error {
		var in struct {
			Fields   map[string]string `json:"fields"`
			SourceID string            `json:"sourceId"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		op, e := s.get(c, "operations", c.Param("id"))
		if e != nil {
			return e
		}
		if str(op, "status") != "NEEDS_INPUT" || str(op, "type") != "EVIDENCE_IMPORT" {
			return conflict("입력 대기 작업이 아닙니다")
		}
		if len(in.Fields) != 1 || !length(in.Fields["text"], 1, 100000) {
			return invalid("text만 입력하세요")
		}
		source := str(op, "sourceId")
		if in.SourceID != "" {
			if _, e = s.get(c, "sources", in.SourceID); e != nil {
				return e
			}
			source = in.SourceID
		}
		out, e := s.importText(c, in.Fields["text"], source, "")
		if e != nil {
			return e
		}
		op["status"] = "SUCCEEDED"
		op["progress"] = 100
		op["inputRequest"] = nil
		op["result"] = map[string]any{"kind": "EVIDENCE_IMPORT", "value": map[string]any{"evidence": out, "warnings": []any{}}}
		op, e = s.update(c, "operations", op, number(op, "revision"))
		if e != nil {
			return e
		}
		delete(op, "revision")
		return ok(c, 200, op)
	})
}
func (s *Server) importText(c echo.Context, text, source, sourceURL string) ([]any, error) {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	if source == "" {
		v, e := s.create(c, "sources", "", map[string]any{"fileName": "imported-source.txt", "mimeType": "text/plain", "size": len(text), "sha256": hash(text), "status": "EXTRACTED"})
		if e != nil {
			return nil, e
		}
		source = str(v, "id")
		if _, e = s.q(c).Exec(c.Request().Context(), "INSERT INTO source_files(id,owner_id,content,extracted_text) VALUES($1,$2,$3,$4)", source, owner(c), []byte(text), text); e != nil {
			return nil, e
		}
	} else {
		tag, e := s.q(c).Exec(c.Request().Context(), "UPDATE source_files SET extracted_text=$3 WHERE id=$1 AND owner_id=$2 AND (extracted_text IS NULL OR extracted_text=$3)", source, owner(c), text)
		if e != nil {
			return nil, e
		}
		if tag.RowsAffected() == 0 {
			return nil, conflict("이미 인용된 원본 추출문은 변경할 수 없습니다. 새 원본을 등록하세요")
		}
	}
	out := []any{}
	position := 0
	kind := "RESUME"
	for _, paragraph := range strings.Split(text, "\n\n") {
		start := position
		end := start + len([]rune(paragraph))
		position = end + 2
		if !nonempty(paragraph) {
			continue
		}
		heading := strings.Trim(strings.ToLower(strings.Split(paragraph, "\n")[0]), "# *\t")
		switch heading {
		case "경력", "경력 사항", "experience", "work experience", "성과", "achievements":
			kind = "CAREER"
		case "학력", "education":
			kind = "EDUCATION"
		case "프로젝트", "projects":
			kind = "PROJECT"
		case "기술", "기술 스택", "skills":
			kind = "SKILL"
		}
		title := []rune(strings.Split(paragraph, "\n")[0])
		if len(title) > 200 {
			title = title[:200]
		}
		v, e := s.create(c, "career-evidence", "", map[string]any{"kind": kind, "title": string(title), "sourceText": paragraph, "sourceUrl": nullable(sourceURL), "skills": []string{}, "verificationStatus": "USER_PROVIDED", "archived": false, "supersedesId": nil, "provenance": map[string]any{"sourceId": source, "projectEvidenceId": nil, "contentHash": hash(paragraph), "sourceLocation": map[string]any{"start": start, "end": end, "unit": "CODE_POINT"}}})
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, nil
}
