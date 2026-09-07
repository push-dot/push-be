package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

func token() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func challenge(v string) string {
	h := sha256.Sum256([]byte(v))
	return base64.RawURLEncoding.EncodeToString(h[:])
}
func (s *Server) providerRequest(ctx context.Context, method, endpoint string, body io.Reader, headers map[string]string) (map[string]any, error) {
	req, e := http.NewRequestWithContext(ctx, method, endpoint, body)
	if e != nil {
		return nil, e
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	req.Header.Set("Accept", "application/json")
	resp, e := s.HTTP.Do(req)
	if e != nil {
		return nil, fail(502, "PROVIDER_ERROR", "외부 제공자에 연결하지 못했습니다")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fail(502, "PROVIDER_ERROR", "외부 제공자가 요청을 거부했습니다")
	}
	var out map[string]any
	if e = json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&out); e != nil {
		return nil, fail(502, "PROVIDER_ERROR", "외부 응답을 해석하지 못했습니다")
	}
	return out, nil
}
func (s *Server) oauthSettings(provider string) (string, string, string, string) {
	if provider == "google" {
		return s.Config.GoogleClientID, s.Config.GoogleClientSecret, "https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token"
	}
	if provider == "github" {
		return s.Config.GitHubClientID, s.Config.GitHubClientSecret, "https://github.com/login/oauth/authorize", "https://github.com/login/oauth/access_token"
	}
	return "", "", "", ""
}
func (s *Server) authRoutes() {
	g := s.Echo.Group("/api/v1/auth", middleware.RateLimiter(middleware.NewRateLimiterMemoryStore(20)))
	g.GET("/:provider/start", func(c echo.Context) error {
		p := c.Param("provider")
		client, secret, authorize, _ := s.oauthSettings(p)
		if client == "" || secret == "" || s.Config.PublicURL == "" {
			return fail(503, "NOT_CONFIGURED", "OAuth 설정이 필요합니다")
		}
		ch := c.QueryParam("codeChallenge")
		redirect := c.QueryParam("redirectUri")
		if c.QueryParam("codeChallengeMethod") != "S256" || !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(ch) || redirect != "push://auth/callback" {
			return invalid("PKCE S256과 허용된 redirectUri가 필요합니다")
		}
		state, verifier := token(), token()
		_, e := s.DB.Exec(c.Request().Context(), "INSERT INTO oauth_states(state_hash,provider,challenge,redirect_uri,verifier,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')", hash(state), p, ch, redirect, verifier)
		if e != nil {
			return e
		}
		q := url.Values{"client_id": {client}, "redirect_uri": {strings.TrimRight(s.Config.PublicURL, "/") + "/api/v1/auth/" + p + "/callback"}, "response_type": {"code"}, "state": {state}, "code_challenge": {challenge(verifier)}, "code_challenge_method": {"S256"}}
		if p == "google" {
			scope := "openid email profile"

			q.Set("scope", scope)
		} else {
			q.Set("scope", "read:user")
		}
		return ok(c, 200, map[string]string{"authorizationUrl": authorize + "?" + q.Encode(), "state": state, "expiresAt": time.Now().UTC().Add(10 * time.Minute).Format(time.RFC3339)})
	})
	g.GET("/:provider/callback", func(c echo.Context) error {
		p := c.Param("provider")
		client, secret, _, endpoint := s.oauthSettings(p)
		if client == "" || secret == "" {
			return fail(503, "NOT_CONFIGURED", "OAuth 설정이 필요합니다")
		}
		var ch, redirect, verifier string
		err := s.DB.QueryRow(c.Request().Context(), "DELETE FROM oauth_states WHERE state_hash=$1 AND provider=$2 AND expires_at>now() RETURNING challenge,redirect_uri,verifier", hash(c.QueryParam("state")), p).Scan(&ch, &redirect, &verifier)
		if err != nil || c.QueryParam("code") == "" {
			return fail(401, "UNAUTHENTICATED", "OAuth state가 만료되었거나 유효하지 않습니다")
		}
		form := url.Values{"client_id": {client}, "client_secret": {secret}, "code": {c.QueryParam("code")}, "redirect_uri": {strings.TrimRight(s.Config.PublicURL, "/") + "/api/v1/auth/" + p + "/callback"}, "grant_type": {"authorization_code"}, "code_verifier": {verifier}}
		result, err := s.providerRequest(c.Request().Context(), "POST", endpoint, strings.NewReader(form.Encode()), map[string]string{"Content-Type": "application/x-www-form-urlencoded"})
		if err != nil {
			return err
		}
		access := str(result, "access_token")
		if access == "" {
			return fail(502, "PROVIDER_ERROR", "OAuth 토큰을 발급하지 못했습니다")
		}
		identityURL := "https://api.github.com/user"
		if p == "google" {
			identityURL = "https://openidconnect.googleapis.com/v1/userinfo"
		}
		identity, err := s.providerRequest(c.Request().Context(), "GET", identityURL, nil, map[string]string{"Authorization": "Bearer " + access})
		if err != nil {
			return err
		}
		subject := str(identity, "sub")
		if p == "github" {
			if n, ok := identity["id"].(float64); ok && n > 0 {
				b, _ := json.Marshal(n)
				subject = string(b)
			}
		}
		if subject == "" {
			return fail(502, "PROVIDER_ERROR", "제공자 사용자 ID가 없습니다")
		}
		tx, err := s.DB.Begin(c.Request().Context())
		if err != nil {
			return err
		}
		defer tx.Rollback(context.Background())
		var user string
		err = tx.QueryRow(c.Request().Context(), "INSERT INTO identities(provider,subject,user_id) VALUES($1,$2,$3) ON CONFLICT(provider,subject) DO UPDATE SET subject=EXCLUDED.subject RETURNING user_id", p, subject, uuid.NewString()).Scan(&user)
		if err != nil {
			return err
		}
		if p == "google" && s.Config.GoogleBeta && str(result, "refresh_token") != "" {
			encrypted, e := s.encrypt([]byte(str(result, "refresh_token")), user+":google")
			if e != nil {
				return e
			}
			if _, e = tx.Exec(c.Request().Context(), "INSERT INTO google_connections(owner_id,ciphertext) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET ciphertext=$2", user, encrypted); e != nil {
				return e
			}
		}
		code := token()
		_, err = tx.Exec(c.Request().Context(), "INSERT INTO auth_codes(code_hash,user_id,challenge,expires_at) VALUES($1,$2,$3,now()+interval '60 seconds')", hash(code), user, ch)
		if err != nil {
			return err
		}
		if err = tx.Commit(c.Request().Context()); err != nil {
			return err
		}
		return c.Redirect(302, redirect+"?code="+url.QueryEscape(code))
	})
	g.POST("/exchange", func(c echo.Context) error {
		var in struct {
			Code     string `json:"code"`
			Verifier string `json:"codeVerifier"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if len(in.Verifier) < 43 || len(in.Verifier) > 128 {
			return fail(401, "UNAUTHENTICATED", "PKCE 검증에 실패했습니다")
		}
		tx, e := s.DB.Begin(c.Request().Context())
		if e != nil {
			return e
		}
		defer tx.Rollback(context.Background())
		var user, ch string
		if e = tx.QueryRow(c.Request().Context(), "SELECT user_id,challenge FROM auth_codes WHERE code_hash=$1 AND expires_at>now() FOR UPDATE", hash(in.Code)).Scan(&user, &ch); e != nil {
			return fail(401, "UNAUTHENTICATED", "코드가 만료되었거나 사용되었습니다")
		}
		if subtle.ConstantTimeCompare([]byte(ch), []byte(challenge(in.Verifier))) != 1 {
			return fail(401, "UNAUTHENTICATED", "PKCE 검증에 실패했습니다")
		}
		if _, e = tx.Exec(c.Request().Context(), "DELETE FROM auth_codes WHERE code_hash=$1", hash(in.Code)); e != nil {
			return e
		}
		v, e := s.issueTokens(c, tx, user)
		if e != nil {
			return e
		}
		if e = tx.Commit(c.Request().Context()); e != nil {
			return e
		}
		return ok(c, 200, v)
	})
	g.POST("/refresh", func(c echo.Context) error {
		var in struct {
			Refresh string `json:"refreshToken"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		tx, e := s.DB.Begin(c.Request().Context())
		if e != nil {
			return e
		}
		defer tx.Rollback(context.Background())
		var user string
		if e = tx.QueryRow(c.Request().Context(), "DELETE FROM sessions WHERE refresh_hash=$1 AND refresh_expires>now() RETURNING user_id", hash(in.Refresh)).Scan(&user); e != nil {
			return fail(401, "UNAUTHENTICATED", "리프레시 토큰이 만료되었거나 사용되었습니다")
		}
		v, e := s.issueTokens(c, tx, user)
		if e != nil {
			return e
		}
		if e = tx.Commit(c.Request().Context()); e != nil {
			return e
		}
		return ok(c, 200, v)
	})
	g.POST("/logout", func(c echo.Context) error {
		var in struct {
			Refresh string `json:"refreshToken"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if _, e := s.DB.Exec(c.Request().Context(), "DELETE FROM sessions WHERE refresh_hash=$1", hash(in.Refresh)); e != nil {
			return e
		}
		return empty(c)
	})
	s.Echo.POST("/api/v1/billing/webhook", s.stripeWebhook)
	s.Echo.GET("/api/v1/integrations/google/callback", s.googleCallback)
}
func (s *Server) issueTokens(c echo.Context, tx pgx.Tx, user string) (map[string]any, error) {
	access, refresh := token(), token()
	_, e := tx.Exec(c.Request().Context(), "INSERT INTO sessions(access_hash,refresh_hash,user_id,access_expires,refresh_expires) VALUES($1,$2,$3,$4,$5)", hash(access), hash(refresh), user, time.Now().Add(15*time.Minute), time.Now().Add(30*24*time.Hour))
	if e != nil {
		return nil, e
	}
	return map[string]any{"accessToken": access, "refreshToken": refresh, "expiresIn": 900, "user": map[string]string{"id": user, "displayName": "", "locale": "ko"}}, nil
}
