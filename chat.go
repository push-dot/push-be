package main

import "github.com/labstack/echo/v4"

func (s *Server) snapshotChat(c echo.Context, app string, job *AIJob) error {
	application, e := s.get(c, "applications", app)
	if e != nil {
		return e
	}
	posting, e := s.get(c, "jobs", str(application, "jobId"))
	if e != nil {
		return e
	}
	job.JobSnapshot = map[string]any{"applicationId": app, "jobId": posting["id"], "company": posting["company"], "title": posting["title"], "sourceText": posting["sourceText"], "requirements": posting["requirements"], "preferred": posting["preferred"]}
	if job.DocumentID == "" && job.VersionID == "" {
		return nil
	}
	var doc, version map[string]any
	if job.VersionID != "" {
		version, e = s.get(c, "versions", job.VersionID)
		if e != nil {
			return e
		}
		if job.DocumentID != "" && job.DocumentID != str(version, "documentId") {
			return invalid("문서와 버전이 다릅니다")
		}
		job.DocumentID = str(version, "documentId")
	}
	doc, e = s.get(c, "documents", job.DocumentID)
	if e != nil {
		return e
	}
	if version == nil {
		job.VersionID = str(doc, "latestVersionId")
		if job.VersionID == "" {
			return invalid("선택한 문서에 버전이 없습니다")
		}
		version, e = s.get(c, "versions", job.VersionID)
		if e != nil {
			return e
		}
	}
	if str(doc, "applicationId") != app || str(version, "applicationId") != app {
		return invalid("다른 지원의 대화 문맥입니다")
	}
	seen := map[string]bool{}
	ids := []string{}
	add := func(id string) {
		if id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	for _, id := range job.EvidenceIDs {
		add(id)
	}
	blocks, _ := version["blocks"].([]any)
	for _, raw := range blocks {
		block, _ := raw.(map[string]any)
		refs, _ := block["evidenceRefs"].([]any)
		for _, raw := range refs {
			ref, _ := raw.(map[string]any)
			add(str(ref, "evidenceId"))
		}
	}
	job.EvidenceIDs = ids
	job.ChatSnapshot = map[string]any{"applicationId": app, "documentId": job.DocumentID, "versionId": job.VersionID, "title": doc["title"], "number": version["number"], "content": version["content"], "blocks": version["blocks"]}
	job.Attachments = []any{map[string]any{"type": "DOCUMENT_VERSION", "id": job.VersionID, "documentId": job.DocumentID, "title": doc["title"]}}
	return nil
}
