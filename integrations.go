package main

import (
	"github.com/labstack/echo/v4"
	"time"
)

func (s *Server) integrationRoutes(g *echo.Group) {
	g.GET("/auth/me", func(c echo.Context) error {
		var name, locale string
		var at time.Time
		_, e := s.q(c).Exec(c.Request().Context(), "INSERT INTO user_profiles(id) VALUES($1) ON CONFLICT DO NOTHING", owner(c))
		if e != nil {
			return e
		}
		e = s.q(c).QueryRow(c.Request().Context(), "SELECT display_name,locale,created_at FROM user_profiles WHERE id=$1", owner(c)).Scan(&name, &locale, &at)
		if e != nil {
			return e
		}
		return ok(c, 200, map[string]any{"id": owner(c), "displayName": name, "locale": locale, "createdAt": at.UTC()})
	})
	g.PUT("/ai/keys/:provider", func(c echo.Context) error {
		p := c.Param("provider")
		if !oneOf(p, "OPENAI", "CLAUDE", "GEMINI", "GROK") {
			return invalid("제공자를 확인하세요")
		}
		var in struct {
			Key string `json:"key"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if len(in.Key) < 12 || len(in.Key) > 4096 {
			return invalid("키 길이를 확인하세요")
		}
		b, e := s.encrypt([]byte(in.Key), owner(c)+":"+p+":v1")
		if e != nil {
			return e
		}
		_, e = s.q(c).Exec(c.Request().Context(), "INSERT INTO ai_keys(owner_id,provider,ciphertext,last_four) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,provider) DO UPDATE SET ciphertext=$3,last_four=$4,updated_at=now()", owner(c), p, b, in.Key[len(in.Key)-4:])
		if e != nil {
			return e
		}
		return ok(c, 200, map[string]any{"provider": p, "lastFour": in.Key[len(in.Key)-4:], "configured": true, "updatedAt": time.Now().UTC()})
	})
	g.GET("/ai/keys", func(c echo.Context) error {
		rows, e := s.q(c).Query(c.Request().Context(), "SELECT provider,last_four,updated_at FROM ai_keys WHERE owner_id=$1 ORDER BY provider", owner(c))
		if e != nil {
			return e
		}
		defer rows.Close()
		out := []any{}
		for rows.Next() {
			var p, l string
			var at time.Time
			if e = rows.Scan(&p, &l, &at); e != nil {
				return e
			}
			out = append(out, map[string]any{"provider": p, "lastFour": l, "configured": true, "updatedAt": at})
		}
		if e = rows.Err(); e != nil {
			return e
		}
		return ok(c, 200, out)
	})
	g.DELETE("/ai/keys/:provider", func(c echo.Context) error {
		if !oneOf(c.Param("provider"), "OPENAI", "CLAUDE", "GEMINI", "GROK") {
			return invalid("제공자를 확인하세요")
		}
		_, e := s.q(c).Exec(c.Request().Context(), "DELETE FROM ai_keys WHERE owner_id=$1 AND provider=$2", owner(c), c.Param("provider"))
		if e != nil {
			return e
		}
		return empty(c)
	})
	s.billingRoutes(g)
	s.aiRoutes(g)
	s.googleRoutes(g)
	g.GET("/integrations/job-sites", func(c echo.Context) error {
		out := []any{}
		for _, p := range []string{"WANTED", "JUMPIT", "JOBKOREA"} {
			out = append(out, map[string]any{"provider": p, "enabled": false, "permissionVerified": false, "supportedFields": []string{}, "mode": "MANUAL_CHECKLIST", "checklist": []string{"공고와 지원 조건 확인", "확정한 서류 첨부", "제출 내용 직접 검토", "사이트에서 직접 제출", "제출 완료를 Push에 기록"}})
		}
		return ok(c, 200, out)
	})
}
