package main

import (
	"encoding/json"
	"github.com/labstack/echo/v4"
	"unicode/utf16"
)

func selectionBlock(root TipTapNode, selection Selection) (string, int, int, error) {
	position := 0
	found := ""
	start, end := 0, 0
	var walk func(TipTapNode)
	walk = func(n TipTapNode) {
		if n.Type == "text" {
			position += len(utf16.Encode([]rune(n.Text)))
			return
		}
		if n.Type == "hardBreak" {
			position++
			return
		}
		if n.Type != "doc" {
			position++
		}
		at := position
		if oneOf(n.Type, "paragraph", "heading") {
			var text string
			for _, child := range n.Content {
				if child.Type == "text" {
					text += child.Text
				} else if child.Type == "hardBreak" {
					text += "\n"
				}
			}
			units := utf16.Encode([]rune(text))
			a, b := selection.From-at, selection.To-at
			if a >= 0 && b > a && b <= len(units) && string(utf16.Decode(units[a:b])) == selection.Text {
				found, _ = n.Attrs["blockId"].(string)
				start = len([]rune(string(utf16.Decode(units[:a]))))
				end = start + len([]rune(selection.Text))
			}
		}
		for _, child := range n.Content {
			walk(child)
		}
		if n.Type != "doc" {
			position++
		}
	}
	walk(root)
	if found == "" {
		return "", 0, 0, invalid("선택 범위와 원문이 일치하지 않습니다")
	}
	return found, start, end, nil
}
func (s *Server) revisionRoutes(g *echo.Group) {
	g.POST("/documents/:id/revisions", func(c echo.Context) error {
		var in struct {
			Expected    int       `json:"expectedRevision"`
			VersionID   string    `json:"versionId"`
			Selection   Selection `json:"selection"`
			Action      string    `json:"action"`
			Instruction string    `json:"instruction"`
			AI          AiOptions `json:"ai"`
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
		if !oneOf(in.Action, "REWRITE", "SHORTEN", "EMPHASIZE_METRICS", "CHANGE_TONE", "TAILOR_TO_JOB") {
			return invalid("수정 action 오류")
		}
		var content TipTapNode
		b, _ := json.Marshal(v["content"])
		if e = json.Unmarshal(b, &content); e != nil {
			return e
		}
		blockID, _, _, e := selectionBlock(content, in.Selection)
		if e != nil {
			return e
		}
		ids := []string{}
		for _, raw := range v["blocks"].([]any) {
			block := raw.(map[string]any)
			if str(block, "id") == blockID {
				for _, r := range block["evidenceRefs"].([]any) {
					ids = append(ids, str(r.(map[string]any), "evidenceId"))
				}
			}
		}
		return s.queueAI(c, "DOCUMENT_REVISE", str(d, "applicationId"), AIJob{AI: in.AI, Prompt: in.Action + ": " + in.Instruction + "\nRewrite only this selected text, return replacement text only:\n" + in.Selection.Text, EvidenceIDs: ids, DocumentID: str(d, "id"), Expected: in.Expected, VersionID: in.VersionID, Selection: &in.Selection})
	})
	g.POST("/documents/:id/revisions/:revisionId/apply", func(c echo.Context) error {
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
		if e = s.checkRevision(c, d, in.Expected); e != nil {
			return e
		}
		p, e := s.get(c, "revision-proposals", c.Param("revisionId"))
		if e != nil {
			return e
		}
		if str(p, "documentId") != str(d, "id") || str(p, "sourceVersionId") != str(d, "latestVersionId") || number(p, "sourceRevision") != in.Expected {
			return fail(409, "REVISION_CONFLICT", "제안 이후 문서가 변경되었습니다")
		}
		v, e := s.get(c, "versions", str(p, "sourceVersionId"))
		if e != nil {
			return e
		}
		var selection Selection
		raw, _ := json.Marshal(p["selection"])
		json.Unmarshal(raw, &selection)
		var content TipTapNode
		raw, _ = json.Marshal(v["content"])
		json.Unmarshal(raw, &content)
		blockID, start, end, e := selectionBlock(content, selection)
		if e != nil {
			return e
		}
		blocks := []BlockInput{}
		for _, raw := range v["blocks"].([]any) {
			m := raw.(map[string]any)
			b := BlockInput{ID: str(m, "id"), Text: str(m, "text"), EvidenceRefs: []EvidenceRef{}}
			for _, r := range m["evidenceRefs"].([]any) {
				ref := r.(map[string]any)
				b.EvidenceRefs = append(b.EvidenceRefs, EvidenceRef{EvidenceID: str(ref, "evidenceId"), Start: number(ref, "start"), End: number(ref, "end")})
			}
			if b.ID == blockID {
				runes := []rune(b.Text)
				b.Text = string(runes[:start]) + str(p, "replacement") + string(runes[end:])
				var replace func(*TipTapNode)
				replace = func(n *TipTapNode) {
					if n.Attrs["blockId"] == blockID {
						n.Content = []TipTapNode{{Type: "text", Text: b.Text}}
					}
					for i := range n.Content {
						replace(&n.Content[i])
					}
				}
				replace(&content)
			}
			blocks = append(blocks, b)
		}
		result, e := s.version(c, d, in.Expected, content, blocks, "승인한 AI 수정 제안 적용")
		if e != nil {
			return e
		}
		return ok(c, 201, result)
	})
}
