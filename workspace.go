package main

import (
	"fmt"
	"github.com/labstack/echo/v4"
	"strconv"
	"strings"
	"time"
)

func (s *Server) workspaceRoutes(g *echo.Group) {
	s.calendarRoutes(g)
	s.syncRoutes(g)
	s.sourceRoutes(g)
	g.POST("/conversations", func(c echo.Context) error {
		var in struct {
			ApplicationID string `json:"applicationId"`
			Title         string `json:"title"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		a, e := s.get(c, "applications", in.ApplicationID)
		if e != nil {
			return e
		}
		if in.Title == "" {
			in.Title = str(a, "company") + " 지원"
		}
		if !length(in.Title, 1, 200) {
			return invalid("제목 길이 오류")
		}
		v, e := s.create(c, "conversations", in.ApplicationID, map[string]any{"applicationId": in.ApplicationID, "title": in.Title, "pinned": false, "archived": false})
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.PATCH("/conversations/:id", func(c echo.Context) error {
		var in struct {
			Expected int     `json:"expectedRevision"`
			Title    *string `json:"title"`
			Pinned   *bool   `json:"pinned"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		v, e := s.get(c, "conversations", c.Param("id"))
		if e != nil {
			return e
		}
		if in.Title != nil {
			if !length(*in.Title, 1, 200) {
				return invalid("제목 오류")
			}
			v["title"] = *in.Title
		}
		if in.Pinned != nil {
			v["pinned"] = *in.Pinned
		}
		return s.save(c, "conversations", v, in.Expected)
	})
	g.POST("/conversations/:id/archive", func(c echo.Context) error {
		var in struct {
			Expected int `json:"expectedRevision"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		v, e := s.get(c, "conversations", c.Param("id"))
		if e != nil {
			return e
		}
		v["archived"] = true
		return s.save(c, "conversations", v, in.Expected)
	})
	g.GET("/conversations/:id/messages", func(c echo.Context) error {
		conv, e := s.get(c, "conversations", c.Param("id"))
		if e != nil {
			return e
		}
		v, e := s.list(c, "messages", str(conv, "applicationId"))
		if e != nil {
			return e
		}
		return page(c, filter(v, "conversationId", c.Param("id")))
	})
	g.POST("/conversations/:id/messages", func(c echo.Context) error {
		var in struct {
			Text    string `json:"text"`
			Context struct {
				DocumentID  string   `json:"documentId"`
				VersionID   string   `json:"versionId"`
				EvidenceIDs []string `json:"evidenceIds"`
			} `json:"context"`
			AI     *AiOptions `json:"ai"`
			Access string     `json:"accessMode"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		conv, e := s.get(c, "conversations", c.Param("id"))
		if e != nil {
			return e
		}
		if !length(in.Text, 1, 100000) || !oneOf(in.Access, "SUGGEST", "CONFIRM_ACTIONS") {
			return invalid("메시지와 접근 모드 오류")
		}
		for kind, id := range map[string]string{"documents": in.Context.DocumentID, "versions": in.Context.VersionID} {
			if id != "" {
				v, e := s.get(c, kind, id)
				if e != nil {
					return e
				}
				if str(v, "applicationId") != str(conv, "applicationId") {
					return invalid("다른 지원의 대화 문맥입니다")
				}
				if kind == "versions" && in.Context.DocumentID != "" && str(v, "documentId") != in.Context.DocumentID {
					return invalid("문서와 버전이 다릅니다")
				}
			}
		}
		if _, e = s.evidenceFor(c, str(conv, "applicationId"), in.Context.EvidenceIDs, true); e != nil {
			return e
		}
		return s.aiUnavailable(c, in.AI)
	})
	g.POST("/pins", func(c echo.Context) error {
		var in struct {
			Type string `json:"resourceType"`
			ID   string `json:"resourceId"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		kind := map[string]string{"JOB": "jobs", "DOCUMENT": "documents"}[in.Type]
		if kind == "" {
			return invalid("고정 종류 오류")
		}
		r, e := s.get(c, kind, in.ID)
		if e != nil {
			return e
		}
		items, e := s.list(c, "pins", "")
		if e != nil {
			return e
		}
		for _, x := range items {
			v := x.(map[string]any)
			if str(v, "resourceId") == in.ID {
				return ok(c, 200, v)
			}
		}
		v, e := s.create(c, "pins", str(r, "applicationId"), in)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.DELETE("/pins/:id", func(c echo.Context) error {
		if _, e := s.get(c, "pins", c.Param("id")); e != nil {
			return e
		}
		if _, e := s.q(c).Exec(c.Request().Context(), "DELETE FROM resources WHERE owner_id=$1 AND kind='pins' AND id=$2", owner(c), c.Param("id")); e != nil {
			return e
		}
		return empty(c)
	})
	g.POST("/interviews", func(c echo.Context) error {
		var in struct {
			ApplicationID string   `json:"applicationId"`
			Title         string   `json:"title"`
			At            string   `json:"scheduledAt"`
			Duration      int      `json:"durationMinutes"`
			EvidenceIDs   []string `json:"evidenceIds"`
			Notes         string   `json:"notes"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if _, e := s.get(c, "applications", in.ApplicationID); e != nil {
			return e
		}
		if _, e := s.evidenceFor(c, in.ApplicationID, in.EvidenceIDs, false); e != nil {
			return e
		}
		if in.Duration == 0 {
			in.Duration = 60
		}
		at, e := time.Parse(time.RFC3339, in.At)
		if e != nil || !length(in.Title, 1, 200) || in.Duration < 1 || in.Duration > 1440 {
			return invalid("면접 일시·제목·길이 오류")
		}
		event, e := s.create(c, "calendar-events", in.ApplicationID, map[string]any{"applicationId": in.ApplicationID, "type": "INTERVIEW", "title": in.Title, "startsAt": at.UTC(), "endsAt": at.Add(time.Duration(in.Duration) * time.Minute).UTC(), "timeZone": "UTC", "source": "LOCAL", "externalId": nil, "notes": in.Notes})
		if e != nil {
			return e
		}
		if in.EvidenceIDs == nil {
			in.EvidenceIDs = []string{}
		}
		v, e := s.create(c, "interviews", in.ApplicationID, map[string]any{"applicationId": in.ApplicationID, "title": in.Title, "scheduledAt": in.At, "durationMinutes": in.Duration, "eventId": event["id"], "evidenceIds": in.EvidenceIDs, "notes": in.Notes, "reflection": ""})
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.PATCH("/interviews/:id", func(c echo.Context) error {
		var in struct {
			Expected   int     `json:"expectedRevision"`
			Title      *string `json:"title"`
			At         *string `json:"scheduledAt"`
			Notes      *string `json:"notes"`
			Reflection *string `json:"reflection"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		v, e := s.get(c, "interviews", c.Param("id"))
		if e != nil {
			return e
		}
		if e = s.checkRevision(c, v, in.Expected); e != nil {
			return e
		}
		event, e := s.get(c, "calendar-events", str(v, "eventId"))
		if e != nil {
			return e
		}
		if in.Title != nil {
			if !length(*in.Title, 1, 200) {
				return invalid("면접 제목 오류")
			}
			v["title"] = *in.Title
			event["title"] = *in.Title
		}
		if in.At != nil {
			at, e := time.Parse(time.RFC3339, *in.At)
			if e != nil {
				return invalid("면접 시각 오류")
			}
			v["scheduledAt"] = *in.At
			event["startsAt"] = at.UTC()
			event["endsAt"] = at.Add(time.Duration(number(v, "durationMinutes")) * time.Minute).UTC()
		}
		if in.Notes != nil {
			v["notes"] = *in.Notes
			event["notes"] = *in.Notes
		}
		if in.Reflection != nil {
			v["reflection"] = *in.Reflection
		}
		if _, e = s.update(c, "calendar-events", event, number(event, "revision")); e != nil {
			return e
		}
		return s.save(c, "interviews", v, in.Expected)
	})
	g.POST("/interviews/:id/prepare", func(c echo.Context) error {
		var in struct {
			Expected int        `json:"expectedRevision"`
			AI       *AiOptions `json:"ai"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		v, e := s.get(c, "interviews", c.Param("id"))
		if e != nil {
			return e
		}
		if e = s.checkRevision(c, v, in.Expected); e != nil {
			return e
		}
		if in.AI != nil {
			return s.aiUnavailable(c, in.AI)
		}
		a, e := s.get(c, "applications", str(v, "applicationId"))
		if e != nil {
			return e
		}
		j, e := s.get(c, "jobs", str(a, "jobId"))
		if e != nil {
			return e
		}
		evs, e := s.evidenceFor(c, str(v, "applicationId"), stringsAt(v, "evidenceIds"), true)
		if e != nil {
			return e
		}
		questions, answers := []any{}, []any{}
		for _, r := range stringsAt(j, "requirements") {
			questions = append(questions, map[string]any{"question": r + "를 사용한 경험과 선택 이유를 설명하세요.", "requirement": r, "evidenceIds": matching(evs, r)})
		}
		for _, ev := range evs {
			answers = append(answers, map[string]any{"evidenceIds": []string{str(ev, "id")}, "situation": "", "task": "", "action": ev["sourceText"], "result": "", "needsInput": []string{"situation", "task", "result"}})
		}
		return s.operation(c, "INTERVIEW_PREPARE", str(v, "applicationId"), map[string]any{"questions": questions, "starAnswers": answers, "research": []any{}})
	})
	g.POST("/offers", func(c echo.Context) error {
		var in OfferInput
		if e := decode(c, &in); e != nil {
			return e
		}
		if _, e := s.get(c, "applications", in.ApplicationID); e != nil {
			return e
		}
		if e := validateOffer(in); e != nil {
			return e
		}
		m := fields(in)
		m["equity"] = nullable(in.Equity)
		m["deadline"] = nullable(in.Deadline)
		if in.Benefits == nil {
			m["benefits"] = []string{}
		}
		v, e := s.create(c, "offers", in.ApplicationID, m)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.PATCH("/offers/:id", func(c echo.Context) error {
		var in struct {
			Expected int       `json:"expectedRevision"`
			Salary   *int64    `json:"annualSalaryMinor"`
			Currency *string   `json:"currency"`
			Equity   *string   `json:"equity"`
			Benefits *[]string `json:"benefits"`
			Deadline *string   `json:"deadline"`
			Notes    *string   `json:"notes"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		v, e := s.get(c, "offers", c.Param("id"))
		if e != nil {
			return e
		}
		if in.Salary != nil {
			if *in.Salary < 0 || *in.Salary > 9007199254740991 {
				return invalid("금액 오류")
			}
			v["annualSalaryMinor"] = *in.Salary
		}
		if in.Currency != nil {
			if !currency(*in.Currency) {
				return invalid("통화 오류")
			}
			v["currency"] = *in.Currency
		}
		if in.Equity != nil {
			v["equity"] = nullable(*in.Equity)
		}
		if in.Benefits != nil {
			v["benefits"] = *in.Benefits
		}
		if in.Deadline != nil {
			if !validTime(*in.Deadline) {
				return invalid("마감 시각 오류")
			}
			v["deadline"] = nullable(*in.Deadline)
		}
		if in.Notes != nil {
			v["notes"] = *in.Notes
		}
		return s.save(c, "offers", v, in.Expected)
	})
	g.GET("/offers/compare", func(c echo.Context) error {
		ids := strings.Split(c.QueryParam("ids"), ",")
		if len(ids) < 2 || len(ids) > 10 {
			return invalid("2~10개 오퍼를 선택하세요")
		}
		offers := []any{}
		same := true
		curr := ""
		seen := map[string]bool{}
		for _, id := range ids {
			if seen[id] {
				return invalid("중복 오퍼입니다")
			}
			seen[id] = true
			v, e := s.get(c, "offers", id)
			if e != nil {
				return e
			}
			if curr != "" && curr != str(v, "currency") {
				same = false
			}
			curr = str(v, "currency")
			offers = append(offers, v)
		}
		fields := []any{}
		for _, key := range []string{"annualSalaryMinor", "equity", "benefits", "deadline"} {
			values := []any{}
			for _, raw := range offers {
				v := raw.(map[string]any)
				var value any
				if v[key] != nil {
					value = fmt.Sprint(v[key])
				}
				values = append(values, map[string]any{"offerId": v["id"], "value": value})
			}
			fields = append(fields, map[string]any{"key": key, "values": values})
		}
		return ok(c, 200, map[string]any{"offers": offers, "comparison": map[string]any{"sameCurrency": same, "fields": fields}})
	})
	g.POST("/routines", func(c echo.Context) error {
		var in struct {
			ApplicationID string `json:"applicationId"`
			Title         string `json:"title"`
			Kind          string `json:"kind"`
			Due           string `json:"dueAt"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if _, e := s.get(c, "applications", in.ApplicationID); e != nil {
			return e
		}
		if !length(in.Title, 1, 200) || !oneOf(in.Kind, "DEADLINE", "FOLLOW_UP", "INTERVIEW_PREP", "FOLLOW_UP_EMAIL") || in.Due == "" || !validTime(in.Due) {
			return invalid("루틴 입력 오류")
		}
		v, e := s.create(c, "routines", in.ApplicationID, map[string]any{"applicationId": in.ApplicationID, "title": in.Title, "kind": in.Kind, "dueAt": in.Due, "status": "SUGGESTED", "reason": "사용자 요청"})
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
		prior := str(v, "status")
		if !(prior == "SUGGESTED" && oneOf(in.Status, "CONFIRMED", "DISMISSED") || prior == "CONFIRMED" && oneOf(in.Status, "DONE", "DISMISSED")) {
			return conflict("루틴 상태 전이 오류")
		}
		v["status"] = in.Status
		return s.save(c, "routines", v, in.Expected)
	})
	g.POST("/routines/suggest", s.suggestRoutines)
	g.GET("/applications/:id/timeline", func(c echo.Context) error {
		if _, e := s.get(c, "applications", c.Param("id")); e != nil {
			return e
		}
		v, e := s.list(c, "timeline", c.Param("id"))
		if e != nil {
			return e
		}
		return page(c, v)
	})
}

type OfferInput struct {
	ApplicationID string   `json:"applicationId"`
	Company       string   `json:"company"`
	Salary        int64    `json:"annualSalaryMinor"`
	Currency      string   `json:"currency"`
	Equity        string   `json:"equity"`
	Benefits      []string `json:"benefits"`
	Deadline      string   `json:"deadline"`
	Notes         string   `json:"notes"`
}

func currency(s string) bool {
	return oneOf(s, "KRW", "USD", "EUR", "JPY", "GBP", "CAD", "AUD", "CHF", "CNY", "HKD", "SGD", "INR")
}
func validateOffer(in OfferInput) error {
	if !length(in.Company, 1, 200) || in.Salary < 0 || in.Salary > 9007199254740991 || !currency(in.Currency) || !validTime(in.Deadline) {
		return invalid("오퍼 입력 오류")
	}
	return nil
}
func (s *Server) calendarRoutes(g *echo.Group) {
	g.GET("/calendar/events", func(c echo.Context) error {
		from, e := time.Parse(time.RFC3339, c.QueryParam("from"))
		if e != nil {
			return invalid("from 시각 오류")
		}
		to, e := time.Parse(time.RFC3339, c.QueryParam("to"))
		if e != nil || !to.After(from) || to.Sub(from) > 366*24*time.Hour {
			return invalid("조회 기간은 최대 366일입니다")
		}
		items, e := s.list(c, "calendar-events", c.QueryParam("applicationId"))
		if e != nil {
			return e
		}
		out := []any{}
		for _, raw := range items {
			v := raw.(map[string]any)
			start, _ := time.Parse(time.RFC3339, str(v, "startsAt"))
			end, _ := time.Parse(time.RFC3339, str(v, "endsAt"))
			if start.Before(to) && end.After(from) {
				out = append(out, v)
			}
		}
		return page(c, out)
	})
	g.POST("/calendar/events", func(c echo.Context) error {
		var in struct {
			ApplicationID string `json:"applicationId"`
			Type          string `json:"type"`
			Title         string `json:"title"`
			Start         string `json:"startsAt"`
			End           string `json:"endsAt"`
			Zone          string `json:"timeZone"`
			Notes         string `json:"notes"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if in.ApplicationID != "" {
			if _, e := s.get(c, "applications", in.ApplicationID); e != nil {
				return e
			}
		}
		if !oneOf(in.Type, "INTERVIEW", "DEADLINE", "FOLLOW_UP", "CUSTOM") {
			return invalid("일정 종류 오류")
		}
		if e := validateEvent(in.Title, in.Start, in.End, in.Zone); e != nil {
			return e
		}
		m := fields(in)
		m["applicationId"] = nullable(in.ApplicationID)
		m["source"] = "LOCAL"
		m["externalId"] = nil
		v, e := s.create(c, "calendar-events", in.ApplicationID, m)
		if e != nil {
			return e
		}
		return ok(c, 201, v)
	})
	g.PATCH("/calendar/events/:id", func(c echo.Context) error {
		var in EventPatch
		if e := decode(c, &in); e != nil {
			return e
		}
		v, e := s.get(c, "calendar-events", c.Param("id"))
		if e != nil {
			return e
		}
		if e = applyEventPatch(v, in); e != nil {
			return e
		}
		return s.save(c, "calendar-events", v, in.Expected)
	})
	g.DELETE("/calendar/events/:id", func(c echo.Context) error {
		v, e := s.get(c, "calendar-events", c.Param("id"))
		if e != nil {
			return e
		}
		if str(v, "source") != "LOCAL" {
			return fail(403, "INSUFFICIENT_SCOPE", "Google 일정은 원본에서 변경하세요")
		}
		rev, e := strconv.Atoi(strings.Trim(c.Request().Header.Get("If-Match"), "\""))
		if e != nil {
			return invalid("If-Match revision이 필요합니다")
		}
		if e = s.checkRevision(c, v, rev); e != nil {
			return e
		}
		_, e = s.q(c).Exec(c.Request().Context(), "DELETE FROM resources WHERE id=$1 AND owner_id=$2", v["id"], owner(c))
		if e != nil {
			return e
		}
		return empty(c)
	})
}

type EventPatch struct {
	Expected int     `json:"expectedRevision"`
	Title    *string `json:"title,omitempty"`
	Start    *string `json:"startsAt,omitempty"`
	End      *string `json:"endsAt,omitempty"`
	Zone     *string `json:"timeZone,omitempty"`
	Notes    *string `json:"notes,omitempty"`
}

func applyEventPatch(v map[string]any, in EventPatch) error {
	if str(v, "source") != "LOCAL" {
		return fail(403, "INSUFFICIENT_SCOPE", "Google 일정은 원본에서 변경하세요")
	}
	for key, p := range map[string]*string{"title": in.Title, "startsAt": in.Start, "endsAt": in.End, "timeZone": in.Zone, "notes": in.Notes} {
		if p != nil {
			v[key] = *p
		}
	}
	return validateEvent(str(v, "title"), str(v, "startsAt"), str(v, "endsAt"), str(v, "timeZone"))
}
func validateEvent(title, start, end, zone string) error {
	a, e := time.Parse(time.RFC3339, start)
	if e != nil {
		return invalid("시작 시각 오류")
	}
	b, e := time.Parse(time.RFC3339, end)
	if e != nil || !b.After(a) || !length(title, 1, 200) {
		return invalid("일정 시각·제목 오류")
	}
	if _, e = time.LoadLocation(zone); e != nil || zone == "" {
		return invalid("IANA timeZone이 필요합니다")
	}
	return nil
}
func (s *Server) suggestRoutines(c echo.Context) error {
	apps, e := s.list(c, "applications", "")
	if e != nil {
		return e
	}
	existing, e := s.list(c, "routines", "")
	if e != nil {
		return e
	}
	known := map[string]bool{}
	for _, x := range existing {
		v := x.(map[string]any)
		known[str(v, "applicationId")+":"+str(v, "kind")+":"+str(v, "dueAt")] = true
	}
	out := []any{}
	suggest := func(app, kind, title, due, reason string) error {
		key := app + ":" + kind + ":" + due
		if known[key] {
			return nil
		}
		v, e := s.create(c, "routines", app, map[string]any{"applicationId": app, "kind": kind, "title": title, "dueAt": due, "reason": reason, "status": "SUGGESTED"})
		if e != nil {
			return e
		}
		known[key] = true
		out = append(out, v)
		return nil
	}
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
		if at, e := time.Parse(time.RFC3339, str(j, "deadline")); e == nil && at.After(now) && at.Before(now.Add(72*time.Hour)) {
			if e = suggest(str(a, "id"), "DEADLINE", str(j, "company")+" 마감 확인", at.UTC().Format(time.RFC3339), "마감 72시간 이내"); e != nil {
				return e
			}
		}
		if at, e := time.Parse(time.RFC3339, str(a, "appliedAt")); e == nil && oneOf(str(a, "stage"), "APPLIED", "SCREENING") && at.Add(7*24*time.Hour).Before(now) {
			if e = suggest(str(a, "id"), "FOLLOW_UP", str(j, "company")+" 후속 확인", at.Add(7*24*time.Hour).UTC().Format(time.RFC3339), "지원 후 7일 경과"); e != nil {
				return e
			}
		}
	}
	interviews, e := s.list(c, "interviews", "")
	if e != nil {
		return e
	}
	for _, x := range interviews {
		v := x.(map[string]any)
		if at, e := time.Parse(time.RFC3339, str(v, "scheduledAt")); e == nil && at.After(now) && at.Before(now.Add(72*time.Hour)) {
			if e = suggest(str(v, "applicationId"), "INTERVIEW_PREP", str(v, "title")+" 준비", at.Add(-time.Hour).UTC().Format(time.RFC3339), "면접 72시간 이내"); e != nil {
				return e
			}
		}
	}
	return ok(c, 200, out)
}
