package main

import (
	"encoding/json"
	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"strings"
)

func parseAI(text string, v any) error {
	d := json.NewDecoder(strings.NewReader(text))
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return fail(422, "VERIFICATION_FAILED", "AI 응답 구조가 계약과 다릅니다")
	}
	return nil
}
func (s *Server) finishDomainAI(c echo.Context, kind, app string, job AIJob, text string) (any, error) {
	if kind == "JOB_ANALYSIS" {
		var in struct {
			Risks []string `json:"risks"`
		}
		if e := parseAI(text, &in); e != nil {
			return nil, e
		}
		if len(in.Risks) > 30 {
			return nil, invalid("AI risks 제한 초과")
		}
		j, e := s.get(c, "jobs", job.TargetID)
		if e != nil {
			return nil, e
		}
		if e = s.checkRevision(c, j, job.Expected); e != nil {
			return nil, e
		}
		if in.Risks == nil {
			in.Risks = []string{}
		}
		return s.computeAnalysis(c, j, app, job.EvidenceIDs, "AI_ASSISTED", in.Risks)
	}
	if kind == "PROJECT_BLUEPRINTS" {
		var in struct {
			Projects []struct {
				Title    string   `json:"title"`
				Skills   []string `json:"skills"`
				Problem  string   `json:"problem"`
				Solution string   `json:"solution"`
				Tasks    []struct {
					Title       string   `json:"title"`
					Description string   `json:"description"`
					Acceptance  []string `json:"acceptance"`
				} `json:"tasks"`
				Criteria []string `json:"completionCriteria"`
				Metrics  []struct {
					Name        string   `json:"name"`
					Unit        string   `json:"unit"`
					Measurement string   `json:"measurement"`
					Target      *float64 `json:"target"`
				} `json:"metrics"`
				Effort struct {
					Min float64 `json:"minHours"`
					Max float64 `json:"maxHours"`
				} `json:"estimatedEffort"`
			} `json:"projects"`
		}
		if e := parseAI(text, &in); e != nil {
			return nil, e
		}
		if len(in.Projects) != 4 {
			return nil, fail(422, "VERIFICATION_FAILED", "4개 블루프린트가 필요합니다")
		}
		analysis, e := s.get(c, "analyses", job.TargetID)
		if e != nil {
			return nil, e
		}
		j, e := s.get(c, "jobs", str(analysis, "jobId"))
		if e != nil {
			return nil, e
		}
		allowed := map[string]bool{}
		for _, k := range append(stringsAt(j, "requirements"), stringsAt(j, "preferred")...) {
			allowed[strings.ToLower(k)] = true
		}
		out := []any{}
		for _, p := range in.Projects {
			if !length(p.Title, 1, 200) || !nonempty(p.Problem, p.Solution) || len(p.Skills) == 0 || len(p.Tasks) == 0 || len(p.Criteria) == 0 || len(p.Metrics) == 0 || p.Effort.Min <= 0 || p.Effort.Max < p.Effort.Min {
				return nil, fail(422, "VERIFICATION_FAILED", "블루프린트 완성 기준이 부족합니다")
			}
			for _, k := range p.Skills {
				if !allowed[strings.ToLower(k)] {
					return nil, fail(422, "VERIFICATION_FAILED", "공고에 없는 주요 기술입니다")
				}
			}
			m := fields(p)
			tasks := []any{}
			for _, task := range p.Tasks {
				if !nonempty(task.Title, task.Description) || len(task.Acceptance) == 0 {
					return nil, invalid("작업 완료 조건이 없습니다")
				}
				t := fields(task)
				t["id"] = uuid.NewString()
				tasks = append(tasks, t)
			}
			m["tasks"] = tasks
			m["applicationId"] = app
			m["gapAnalysisId"] = job.TargetID
			m["state"] = "DRAFT"
			v, e := s.create(c, "projects", app, m)
			if e != nil {
				return nil, e
			}
			out = append(out, v)
		}
		return out, nil
	}
	var in struct {
		Questions []struct {
			Question    string   `json:"question"`
			Requirement string   `json:"requirement"`
			EvidenceIDs []string `json:"evidenceIds"`
		} `json:"questions"`
		Answers []struct {
			EvidenceIDs []string `json:"evidenceIds"`
			Situation   string   `json:"situation"`
			Task        string   `json:"task"`
			Action      string   `json:"action"`
			Result      string   `json:"result"`
			NeedsInput  []string `json:"needsInput"`
		} `json:"starAnswers"`
		Research []struct {
			Claim      string `json:"claim"`
			SourceURL  string `json:"sourceUrl"`
			AccessedAt string `json:"accessedAt"`
		} `json:"research"`
	}
	if e := parseAI(text, &in); e != nil {
		return nil, e
	}
	interview, e := s.get(c, "interviews", job.TargetID)
	if e != nil {
		return nil, e
	}
	if e = s.checkRevision(c, interview, job.Expected); e != nil {
		return nil, e
	}
	allowed := map[string]bool{}
	for _, id := range job.EvidenceIDs {
		allowed[id] = true
	}
	for _, q := range in.Questions {
		if !nonempty(q.Question) {
			return nil, invalid("면접 질문이 비었습니다")
		}
		for _, id := range q.EvidenceIDs {
			if !allowed[id] {
				return nil, fail(422, "VERIFICATION_FAILED", "미제공 근거를 인용했습니다")
			}
		}
	}
	for _, answer := range in.Answers {
		source := ""
		for _, id := range answer.EvidenceIDs {
			if !allowed[id] {
				return nil, fail(422, "VERIFICATION_FAILED", "미제공 근거를 인용했습니다")
			}
			ev, e := s.get(c, "career-evidence", id)
			if e != nil {
				return nil, e
			}
			source += str(ev, "sourceText") + "\n"
		}
		for _, claim := range []string{answer.Situation, answer.Task, answer.Action, answer.Result} {
			if claim != "" && !strings.Contains(source, claim) {
				return nil, fail(409, "UNSUPPORTED_CLAIM", "면접 답변의 원문 근거를 확인할 수 없습니다")
			}
		}
	}
	if len(in.Research) > 0 {
		return nil, fail(422, "VERIFICATION_FAILED", "모델이 생성한 회사 조사 대신 저장된 출처 발췌만 사용합니다")
	}
	m := fields(in)
	if in.Questions == nil {
		m["questions"] = []any{}
	}
	if in.Answers == nil {
		m["starAnswers"] = []any{}
	}
	m["research"] = companyResearch(job.CompanySources)
	return m, nil
}
