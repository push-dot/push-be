package main

import (
	"github.com/labstack/echo/v4"
)

func (s *Server) authRoutes() {}
func (s *Server) integrationRoutes(g *echo.Group) {
	g.GET("/auth/me", func(c echo.Context) error { return ok(c, 200, map[string]string{"id": owner(c)}) })
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
		b, e := s.encrypt([]byte(in.Key), owner(c)+":"+p)
		if e != nil {
			return e
		}
		_, e = s.q(c).Exec(c.Request().Context(), "INSERT INTO ai_keys(owner_id,provider,ciphertext,last_four) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,provider) DO UPDATE SET ciphertext=$3,last_four=$4", owner(c), p, b, in.Key[len(in.Key)-4:])
		if e != nil {
			return e
		}
		return ok(c, 200, map[string]string{"provider": p, "lastFour": in.Key[len(in.Key)-4:]})
	})
	g.GET("/ai/keys", func(c echo.Context) error {
		rows, e := s.q(c).Query(c.Request().Context(), "SELECT provider,last_four FROM ai_keys WHERE owner_id=$1 ORDER BY provider", owner(c))
		if e != nil {
			return e
		}
		defer rows.Close()
		out := []any{}
		for rows.Next() {
			var p, l string
			if e = rows.Scan(&p, &l); e != nil {
				return e
			}
			out = append(out, map[string]string{"provider": p, "lastFour": l})
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
		return ok(c, 200, map[string]bool{"deleted": true})
	})
	g.POST("/billing/checkout", func(c echo.Context) error { return fail(503, "NOT_CONFIGURED", "Stripe 설정이 필요합니다") })
	g.POST("/integrations/google/sync", func(c echo.Context) error {
		if !s.Config.GoogleBeta {
			return fail(403, "FORBIDDEN", "Google 연동 베타가 비활성화되어 있습니다")
		}
		return conflict("Google 계정을 연결하세요")
	})
	g.GET("/integrations/job-sites", func(c echo.Context) error {
		out := []any{}
		for _, p := range []string{"WANTED", "JUMPIT", "JOBKOREA"} {
			out = append(out, map[string]any{"provider": p, "enabled": false, "mode": "MANUAL_CHECKLIST", "checklist": []string{"공고와 지원 조건 확인", "확정한 서류 첨부", "제출 내용 직접 검토", "사이트에서 직접 제출", "제출 완료를 Push에 기록"}})
		}
		return ok(c, 200, out)
	})
}
