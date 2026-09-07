package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"github.com/labstack/echo/v4"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func (s *Server) googleStatus(c echo.Context) (map[string]any, error) {
	var scopes []byte
	var last *time.Time
	e := s.q(c).QueryRow(c.Request().Context(), "SELECT scopes,last_synced_at FROM google_connections WHERE owner_id=$1", owner(c)).Scan(&scopes, &last)
	connected := e == nil
	if e != nil && e.Error() != "no rows in result set" {
		return nil, e
	}
	list := []string{}
	if connected {
		json.Unmarshal(scopes, &list)
	}
	gmail := "DISABLED"
	if s.Config.GoogleBeta {
		gmail = "DISCONNECTED"
		if connected && hasScope(list, "gmail.readonly") {
			gmail = "CONNECTED"
		}
	}
	calendar := "DISCONNECTED"
	if connected && hasScope(list, "calendar.readonly") {
		calendar = "CONNECTED"
	}
	return map[string]any{"enabled": s.Config.GoogleBeta, "connected": connected, "scopes": list, "gmailStatus": gmail, "calendarStatus": calendar, "lastSyncedAt": last}, nil
}
func hasScope(scopes []string, suffix string) bool {
	for _, scope := range scopes {
		if strings.HasSuffix(scope, "/"+suffix) {
			return true
		}
	}
	return false
}
func (s *Server) googleRoutes(g *echo.Group) {
	g.GET("/integrations/google", func(c echo.Context) error {
		v, e := s.googleStatus(c)
		if e != nil {
			return e
		}
		return ok(c, 200, v)
	})
	g.POST("/integrations/google/connect", func(c echo.Context) error {
		var in struct {
			Challenge string `json:"codeChallenge"`
			Method    string `json:"codeChallengeMethod"`
			Redirect  string `json:"redirectUri"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if s.Config.GoogleClientID == "" || s.Config.GoogleClientSecret == "" || s.Config.PublicURL == "" {
			return fail(503, "NOT_CONFIGURED", "Google OAuth 설정이 필요합니다")
		}
		if in.Method != "S256" || len(in.Challenge) != 43 || in.Redirect != "push://integrations/google/callback" {
			return invalid("Google 연결 PKCE 오류")
		}
		state, verifier := token(), token()
		_, e := s.q(c).Exec(c.Request().Context(), "INSERT INTO oauth_states(state_hash,provider,challenge,redirect_uri,verifier,owner_id,expires_at) VALUES($1,'google-link',$2,$3,$4,$5,now()+interval '10 minutes')", hash(state), in.Challenge, in.Redirect, verifier, owner(c))
		if e != nil {
			return e
		}
		scope := "https://www.googleapis.com/auth/calendar.readonly"
		if s.Config.GoogleBeta {
			scope += " https://www.googleapis.com/auth/gmail.readonly"
		}
		q := url.Values{"client_id": {s.Config.GoogleClientID}, "redirect_uri": {strings.TrimRight(s.Config.PublicURL, "/") + "/api/v1/integrations/google/callback"}, "response_type": {"code"}, "state": {state}, "code_challenge": {challenge(verifier)}, "code_challenge_method": {"S256"}, "scope": {scope}, "access_type": {"offline"}, "prompt": {"consent"}}
		return ok(c, 200, map[string]string{"authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth?" + q.Encode(), "state": state})
	})
	g.POST("/integrations/google/complete", func(c echo.Context) error {
		var in struct {
			Code     string `json:"integrationCode"`
			Verifier string `json:"codeVerifier"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		var challengeValue string
		var encrypted, scopes []byte
		e := s.q(c).QueryRow(c.Request().Context(), "SELECT challenge,ciphertext,scopes FROM integration_codes WHERE code_hash=$1 AND owner_id=$2 AND expires_at>now() FOR UPDATE", hash(in.Code), owner(c)).Scan(&challengeValue, &encrypted, &scopes)
		if e != nil || subtle.ConstantTimeCompare([]byte(challengeValue), []byte(challenge(in.Verifier))) != 1 {
			return fail(401, "UNAUTHENTICATED", "연결 코드 또는 PKCE 오류")
		}
		if _, e = s.q(c).Exec(c.Request().Context(), "INSERT INTO google_connections(owner_id,ciphertext,scopes) VALUES($1,$2,$3) ON CONFLICT(owner_id) DO UPDATE SET ciphertext=$2,scopes=$3,gmail_history='',calendar_sync=''", owner(c), encrypted, scopes); e != nil {
			return e
		}
		if _, e = s.q(c).Exec(c.Request().Context(), "DELETE FROM integration_codes WHERE code_hash=$1", hash(in.Code)); e != nil {
			return e
		}
		v, e := s.googleStatus(c)
		if e != nil {
			return e
		}
		return ok(c, 200, v)
	})
	g.DELETE("/integrations/google", func(c echo.Context) error {
		var encrypted []byte
		e := s.q(c).QueryRow(c.Request().Context(), "SELECT ciphertext FROM google_connections WHERE owner_id=$1", owner(c)).Scan(&encrypted)
		if e != nil && e.Error() != "no rows in result set" {
			return e
		}
		if len(encrypted) > 0 {
			key, e := s.decrypt(encrypted, owner(c)+":google")
			if e != nil {
				return e
			}
			req, e := http.NewRequestWithContext(c.Request().Context(), "POST", "https://oauth2.googleapis.com/revoke", strings.NewReader(url.Values{"token": {string(key)}}.Encode()))
			if e != nil {
				return e
			}
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			resp, e := s.HTTP.Do(req)
			if e != nil {
				return fail(502, "PROVIDER_ERROR", "Google 토큰 폐기 확인 실패")
			}
			resp.Body.Close()
			if resp.StatusCode != 200 && resp.StatusCode != 400 {
				return fail(502, "PROVIDER_ERROR", "Google 토큰 폐기 실패")
			}
		}
		if _, e = s.q(c).Exec(c.Request().Context(), "DELETE FROM google_connections WHERE owner_id=$1", owner(c)); e != nil {
			return e
		}
		return empty(c)
	})
	g.POST("/integrations/google/sync", s.syncGoogle)
	for _, kind := range []string{"google-messages", "calendar-events"} {
		k := kind
		path := "messages"
		if kind == "calendar-events" {
			path = "events"
		}
		g.GET("/integrations/google/"+path, func(c echo.Context) error {
			items, e := s.list(c, k, c.QueryParam("applicationId"))
			if e != nil {
				return e
			}
			if k == "calendar-events" {
				items = filter(items, "source", "GOOGLE")
			}
			return page(c, items)
		})
	}
	g.POST("/integrations/google/messages/:id/link", func(c echo.Context) error {
		var in struct {
			ApplicationID string `json:"applicationId"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if _, e := s.get(c, "applications", in.ApplicationID); e != nil {
			return e
		}
		m, e := s.get(c, "google-messages", c.Param("id"))
		if e != nil {
			return e
		}
		m["applicationId"] = in.ApplicationID
		v, e := s.update(c, "google-messages", m, number(m, "revision"))
		if e != nil {
			return e
		}
		if _, e = s.q(c).Exec(c.Request().Context(), "UPDATE resources SET application_id=$1 WHERE id=$2", in.ApplicationID, m["id"]); e != nil {
			return e
		}
		return ok(c, 200, v)
	})
}
func (s *Server) googleCallback(c echo.Context) error {
	var user, ch, redirect, verifier string
	e := s.DB.QueryRow(c.Request().Context(), "DELETE FROM oauth_states WHERE state_hash=$1 AND provider='google-link' AND expires_at>now() RETURNING owner_id,challenge,redirect_uri,verifier", hash(c.QueryParam("state"))).Scan(&user, &ch, &redirect, &verifier)
	if e != nil || c.QueryParam("code") == "" {
		return fail(401, "UNAUTHENTICATED", "Google state 오류")
	}
	result, e := s.providerRequest(c.Request().Context(), "POST", "https://oauth2.googleapis.com/token", strings.NewReader(url.Values{"client_id": {s.Config.GoogleClientID}, "client_secret": {s.Config.GoogleClientSecret}, "code": {c.QueryParam("code")}, "grant_type": {"authorization_code"}, "code_verifier": {verifier}, "redirect_uri": {strings.TrimRight(s.Config.PublicURL, "/") + "/api/v1/integrations/google/callback"}}.Encode()), map[string]string{"Content-Type": "application/x-www-form-urlencoded"})
	if e != nil {
		return e
	}
	refresh := str(result, "refresh_token")
	if refresh == "" {
		return fail(502, "PROVIDER_ERROR", "Google refresh token 누락")
	}
	scopes := strings.Fields(str(result, "scope"))
	if !hasScope(scopes, "calendar.readonly") {
		return fail(403, "INSUFFICIENT_SCOPE", "Calendar 동의가 필요합니다")
	}
	encrypted, e := s.encrypt([]byte(refresh), user+":google")
	if e != nil {
		return e
	}
	code := token()
	raw, _ := json.Marshal(scopes)
	_, e = s.DB.Exec(c.Request().Context(), "INSERT INTO integration_codes(code_hash,owner_id,challenge,ciphertext,scopes,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '60 seconds')", hash(code), user, ch, encrypted, raw)
	if e != nil {
		return e
	}
	return c.Redirect(302, redirect+"?integrationCode="+url.QueryEscape(code))
}
func (s *Server) googleGet(ctx context.Context, endpoint, access string) (map[string]any, int, error) {
	req, e := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if e != nil {
		return nil, 0, e
	}
	req.Header.Set("Authorization", "Bearer "+access)
	resp, e := s.HTTP.Do(req)
	if e != nil {
		return nil, 0, fail(502, "PROVIDER_ERROR", "Google 연결 실패")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, resp.StatusCode, fail(502, "PROVIDER_ERROR", "Google 동기화 응답 오류")
	}
	var v map[string]any
	e = json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&v)
	if e != nil {
		return nil, resp.StatusCode, fail(502, "PROVIDER_ERROR", "Google 응답 JSON 오류")
	}
	return v, resp.StatusCode, nil
}
func (s *Server) syncGoogle(c echo.Context) error {
	var encrypted, scopeRaw []byte
	var history, syncToken string
	e := s.q(c).QueryRow(c.Request().Context(), "SELECT ciphertext,scopes,gmail_history,calendar_sync FROM google_connections WHERE owner_id=$1", owner(c)).Scan(&encrypted, &scopeRaw, &history, &syncToken)
	if e != nil {
		if !s.Config.GoogleBeta {
			return fail(403, "FEATURE_DISABLED", "Google beta가 비활성화되어 있습니다")
		}
		return fail(409, "INTEGRATION_REQUIRED", "Google 연결이 필요합니다")
	}
	scopes := []string{}
	json.Unmarshal(scopeRaw, &scopes)
	if !hasScope(scopes, "calendar.readonly") {
		return fail(403, "INSUFFICIENT_SCOPE", "Calendar scope가 없습니다")
	}
	refresh, e := s.decrypt(encrypted, owner(c)+":google")
	if e != nil {
		return e
	}
	tokens, e := s.providerRequest(c.Request().Context(), "POST", "https://oauth2.googleapis.com/token", strings.NewReader(url.Values{"client_id": {s.Config.GoogleClientID}, "client_secret": {s.Config.GoogleClientSecret}, "refresh_token": {string(refresh)}, "grant_type": {"refresh_token"}}.Encode()), map[string]string{"Content-Type": "application/x-www-form-urlencoded"})
	if e != nil {
		return e
	}
	access := str(tokens, "access_token")
	if access == "" {
		return fail(502, "PROVIDER_ERROR", "Google access token 누락")
	}
	messages, events, deleted := 0, 0, 0
	if s.Config.GoogleBeta && hasScope(scopes, "gmail.readonly") {
		profile, _, e := s.googleGet(c.Request().Context(), "https://gmail.googleapis.com/gmail/v1/users/me/profile", access)
		if e != nil {
			return e
		}
		newHistory := str(profile, "historyId")
		page := ""
		ids := map[string]bool{}
		reset := false
		for pages := 0; pages < 100; pages++ {
			q := url.Values{"maxResults": {"100"}}
			endpoint := "https://gmail.googleapis.com/gmail/v1/users/me/messages"
			if history != "" {
				endpoint = "https://gmail.googleapis.com/gmail/v1/users/me/history"
				q.Set("startHistoryId", history)
				q.Set("historyTypes", "messageAdded")
			} else {
				q.Set("q", "{지원 면접 interview application} newer_than:90d")
			}
			if page != "" {
				q.Set("pageToken", page)
			}
			v, status, e := s.googleGet(c.Request().Context(), endpoint+"?"+q.Encode(), access)
			if e != nil {
				if status == 404 && history != "" && !reset {
					history = ""
					page = ""
					reset = true
					continue
				}
				return e
			}
			if history != "" {
				items, _ := v["history"].([]any)
				for _, raw := range items {
					h, _ := raw.(map[string]any)
					adds, _ := h["messagesAdded"].([]any)
					for _, a := range adds {
						m, _ := a.(map[string]any)
						msg, _ := m["message"].(map[string]any)
						if id := str(msg, "id"); id != "" {
							ids[id] = true
						}
					}
				}
			} else {
				items, _ := v["messages"].([]any)
				for _, raw := range items {
					m, _ := raw.(map[string]any)
					ids[str(m, "id")] = true
				}
			}
			page = str(v, "nextPageToken")
			if page == "" {
				break
			}
			if pages == 99 {
				return fail(502, "PROVIDER_ERROR", "Gmail 페이지 제한에 도달하여 체크포인트를 보존했습니다")
			}
		}
		for id := range ids {
			v, _, e := s.googleGet(c.Request().Context(), "https://gmail.googleapis.com/gmail/v1/users/me/messages/"+url.PathEscape(id)+"?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date", access)
			if e != nil {
				return e
			}
			metadata := map[string]any{"externalId": id, "applicationId": nil, "subject": "", "from": "", "date": "", "threadId": v["threadId"]}
			payload, _ := v["payload"].(map[string]any)
			headers, _ := payload["headers"].([]any)
			for _, raw := range headers {
				header, _ := raw.(map[string]any)
				key := strings.ToLower(str(header, "name"))
				if oneOf(key, "subject", "from", "date") {
					metadata[key] = header["value"]
				}
			}
			if _, e = s.upsertExternal(c, "google-messages", id, metadata); e != nil {
				return e
			}
			messages++
		}
		history = newHistory
	}
	page := ""
	reset := false
	nextSync := syncToken
	for pages := 0; pages < 100; pages++ {
		q := url.Values{"maxResults": {"250"}, "showDeleted": {"true"}}
		if syncToken != "" {
			q.Set("syncToken", syncToken)
		}
		if page != "" {
			q.Set("pageToken", page)
		}
		v, status, e := s.googleGet(c.Request().Context(), "https://www.googleapis.com/calendar/v3/calendars/primary/events?"+q.Encode(), access)
		if e != nil {
			if status == 410 && !reset {
				syncToken = ""
				page = ""
				reset = true
				continue
			}
			return e
		}
		items, _ := v["items"].([]any)
		for _, raw := range items {
			event, _ := raw.(map[string]any)
			external := str(event, "id")
			if external == "" {
				return fail(502, "PROVIDER_ERROR", "Calendar event ID 누락")
			}
			if str(event, "status") == "cancelled" {
				tag, e := s.q(c).Exec(c.Request().Context(), "DELETE FROM resources WHERE owner_id=$1 AND kind='calendar-events' AND body->>'source'='GOOGLE' AND body->>'externalId'=$2", owner(c), external)
				if e != nil {
					return e
				}
				deleted += int(tag.RowsAffected())
				continue
			}
			start, _ := event["start"].(map[string]any)
			end, _ := event["end"].(map[string]any)
			starts, ends := str(start, "dateTime"), str(end, "dateTime")
			if starts == "" {
				starts = str(start, "date") + "T00:00:00Z"
			}
			if ends == "" {
				ends = str(end, "date") + "T00:00:00Z"
			}
			zone := str(start, "timeZone")
			if zone == "" {
				zone = "UTC"
			}
			body := map[string]any{"applicationId": nil, "type": "CUSTOM", "title": str(event, "summary"), "startsAt": starts, "endsAt": ends, "timeZone": zone, "source": "GOOGLE", "externalId": external, "notes": ""}
			if _, e = s.upsertExternal(c, "calendar-events", external, body); e != nil {
				return e
			}
			events++
		}
		page = str(v, "nextPageToken")
		if page == "" {
			nextSync = str(v, "nextSyncToken")
			if nextSync == "" {
				return fail(502, "PROVIDER_ERROR", "Calendar syncToken 누락")
			}
			break
		}
		if pages == 99 {
			return fail(502, "PROVIDER_ERROR", "Calendar 페이지 제한에 도달했습니다")
		}
	}
	now := time.Now().UTC()
	if _, e = s.q(c).Exec(c.Request().Context(), "UPDATE google_connections SET gmail_history=$2,calendar_sync=$3,last_synced_at=$4 WHERE owner_id=$1", owner(c), history, nextSync, now); e != nil {
		return e
	}
	return s.operation(c, "GOOGLE_SYNC", "", map[string]any{"messagesUpserted": messages, "eventsUpserted": events, "eventsDeleted": deleted, "completedAt": now})
}
func (s *Server) upsertExternal(c echo.Context, kind, external string, body map[string]any) (map[string]any, error) {
	var id string
	e := s.q(c).QueryRow(c.Request().Context(), "SELECT id FROM resources WHERE owner_id=$1 AND kind=$2 AND body->>'externalId'=$3", owner(c), kind, external).Scan(&id)
	if e != nil {
		if e.Error() == "no rows in result set" {
			return s.create(c, kind, "", body)
		}
		return nil, e
	}
	v, e := s.get(c, kind, id)
	if e != nil {
		return nil, e
	}
	for key, value := range body {
		if key != "applicationId" {
			v[key] = value
		}
	}
	return s.update(c, kind, v, number(v, "revision"))
}
