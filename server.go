package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	GitHubVerificationToken                                                                 string
	GitHubWorkflowID                                                                        int
	Models                                                                                  []ModelConfig
	Environment, DevToken                                                                   string
	AESKey                                                                                  []byte
	PublicURL, GoogleClientID, GoogleClientSecret, GitHubClientID, GitHubClientSecret       string
	GoogleBeta                                                                              bool
	StripeSecret, StripeWebhookSecret, StripePriceID, CheckoutSuccessURL, CheckoutCancelURL string
	OpenAIKey                                                                               string
	ManagedCreditCost                                                                       int64
}
type Server struct {
	DB     *pgxpool.Pool
	Echo   *echo.Echo
	Config Config
	HTTP   *http.Client
}
type queryer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}
type apiError struct {
	Status        int
	Code, Message string
}

func (e *apiError) Error() string                 { return e.Message }
func fail(status int, code, message string) error { return &apiError{status, code, message} }
func invalid(message string) error                { return fail(400, "VALIDATION_ERROR", message) }
func conflict(message string) error               { return fail(409, "INVALID_TRANSITION", message) }
func NewServer(db *pgxpool.Pool, c Config) (*Server, error) {
	if len(c.AESKey) != 32 {
		return nil, errors.New("AES_KEY must contain 32 bytes")
	}
	if c.Environment != "development" && c.DevToken != "" {
		return nil, errors.New("DEV_AUTH_TOKEN is forbidden outside development")
	}
	if _, err := db.Exec(context.Background(), migrationSQL); err != nil {
		return nil, err
	}
	s := &Server{DB: db, Echo: echo.New(), Config: c, HTTP: &http.Client{Timeout: 30 * time.Second}}
	s.Echo.Server.ReadHeaderTimeout = 5 * time.Second
	s.Echo.Server.ReadTimeout = 30 * time.Second
	s.Echo.Server.WriteTimeout = 60 * time.Second
	s.Echo.Server.IdleTimeout = 60 * time.Second
	s.Echo.HideBanner = true
	s.Echo.HidePort = true
	s.Echo.HTTPErrorHandler = func(err error, c echo.Context) {
		if c.Response().Committed {
			return
		}
		e := &apiError{500, "INTERNAL", "요청을 처리하지 못했습니다"}
		var ae *apiError
		var he *echo.HTTPError
		if errors.As(err, &ae) {
			e = ae
		} else if errors.As(err, &he) {
			e = &apiError{he.Code, httpErrorCode(he.Code), http.StatusText(he.Code)}
		}
		_ = c.JSON(e.Status, map[string]any{"error": map[string]any{"code": e.Code, "message": e.Message, "requestId": c.Response().Header().Get("X-Request-ID"), "details": errorDetails(c)}})
	}
	s.Echo.Use(middleware.RequestID(), middleware.Recover(), middleware.BodyLimitWithConfig(middleware.BodyLimitConfig{Limit: "1M", Skipper: func(c echo.Context) bool {
		return c.Request().URL.Path == "/api/v1/sources" && c.Request().Method == "POST"
	}}), middleware.Secure(), middleware.CORSWithConfig(middleware.CORSConfig{AllowOrigins: []string{"http://localhost:5173", "http://127.0.0.1:5173", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"}, AllowMethods: []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}, AllowHeaders: []string{"Authorization", "Content-Type", "Idempotency-Key", "If-Match", "Last-Event-ID"}}))
	s.Echo.GET("/healthz", func(c echo.Context) error { return c.JSON(200, map[string]string{"status": "ok"}) })
	s.Echo.GET("/readyz", func(c echo.Context) error {
		if err := db.Ping(c.Request().Context()); err != nil {
			return fail(503, "UNAVAILABLE", "database unavailable")
		}
		return c.JSON(200, map[string]string{"status": "ready"})
	})
	s.authRoutes()
	g := s.Echo.Group("/api/v1", s.authenticate)
	s.contractRoutes(g)
	s.integrationRoutes(g)
	return s, nil
}
func ok(c echo.Context, status int, v any) error {
	payload := map[string]any{"data": v}
	if c.Get("tx") != nil {
		c.Set("responseStatus", status)
		c.Set("responseBody", payload)
		return nil
	}
	return c.JSON(status, payload)
}
func decode(c echo.Context, v any) error {
	d := json.NewDecoder(c.Request().Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return invalid("유효한 JSON 필드를 입력하세요")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return invalid("JSON 객체는 하나만 허용합니다")
	}
	return nil
}
func owner(c echo.Context) string { return c.Get("owner").(string) }
func (s *Server) q(c echo.Context) queryer {
	if tx, ok := c.Get("tx").(pgx.Tx); ok {
		return tx
	}
	return s.DB
}
func (s *Server) authenticate(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		token := strings.TrimPrefix(c.Request().Header.Get("Authorization"), "Bearer ")
		if token == "" || token == c.Request().Header.Get("Authorization") {
			return fail(401, "UNAUTHENTICATED", "로그인이 필요합니다")
		}
		user := ""
		if s.Config.Environment == "development" && s.Config.DevToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(s.Config.DevToken)) == 1 {
			user = "00000000-0000-4000-8000-000000000001"
		} else {
			if err := s.DB.QueryRow(c.Request().Context(), "SELECT user_id FROM sessions WHERE access_hash=$1 AND access_expires>now()", hash(token)).Scan(&user); err != nil {
				return fail(401, "UNAUTHENTICATED", "토큰이 만료되었거나 유효하지 않습니다")
			}
		}
		c.Set("owner", user)
		if c.Request().Method == "GET" {
			return next(c)
		}
		tx, err := s.DB.Begin(c.Request().Context())
		if err != nil {
			return err
		}
		defer tx.Rollback(context.Background())
		if _, err = tx.Exec(c.Request().Context(), "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", user); err != nil {
			return err
		}
		c.Set("tx", tx)
		idem := c.Request().Header.Get("Idempotency-Key")
		digest := ""
		if c.Request().Method == "POST" {
			if !validID(idem) {
				return invalid("Idempotency-Key UUID가 필요합니다")
			}
			maxBody := int64(1 << 20)
			if c.Request().URL.Path == "/api/v1/sources" {
				maxBody = 21 << 20
			}
			raw, e := io.ReadAll(io.LimitReader(c.Request().Body, maxBody+1))
			if e != nil {
				return e
			}
			if int64(len(raw)) > maxBody {
				return fail(413, "PAYLOAD_TOO_LARGE", "본문 크기를 초과했습니다")
			}
			c.Request().Body = io.NopCloser(bytes.NewReader(raw))
			digest = hash(string(raw))
			var priorHash string
			var response []byte
			var status int
			e = tx.QueryRow(c.Request().Context(), "SELECT body_hash,status,response FROM idempotency WHERE owner_id=$1 AND method=$2 AND path=$3 AND key=$4", user, c.Request().Method, c.Request().URL.Path, idem).Scan(&priorHash, &status, &response)
			if e == nil {
				if priorHash != digest {
					return fail(409, "IDEMPOTENCY_CONFLICT", "같은 키로 다른 요청을 보낼 수 없습니다")
				}
				return c.Blob(status, "application/json", response)
			}
			if !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
		}
		err = next(c)
		if err != nil {
			return err
		}
		if idem != "" && c.Request().Method == "POST" {
			b, e := json.Marshal(c.Get("responseBody"))
			if e != nil {
				return e
			}
			status, _ := c.Get("responseStatus").(int)
			if _, e = tx.Exec(c.Request().Context(), "INSERT INTO idempotency(owner_id,method,path,key,body_hash,status,response) VALUES($1,$2,$3,$4,$5,$6,$7)", user, c.Request().Method, c.Request().URL.Path, idem, digest, status, b); e != nil {
				return e
			}
		}
		if err = tx.Commit(c.Request().Context()); err != nil {
			return err
		}
		if status, ok := c.Get("responseStatus").(int); ok {
			if status == 204 {
				return c.NoContent(204)
			}
			return c.JSON(status, c.Get("responseBody"))
		}
		return nil
	}
}
func hash(s string) string { v := sha256.Sum256([]byte(s)); return hex.EncodeToString(v[:]) }
func (s *Server) encrypt(b []byte, aad string) ([]byte, error) {
	block, err := aes.NewCipher(s.Config.AESKey)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	n := make([]byte, g.NonceSize())
	if _, err = rand.Read(n); err != nil {
		return nil, err
	}
	return g.Seal(n, n, b, []byte(aad)), nil
}
func (s *Server) decrypt(b []byte, aad string) ([]byte, error) {
	block, err := aes.NewCipher(s.Config.AESKey)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(b) < g.NonceSize() {
		return nil, errors.New("invalid encrypted secret")
	}
	return g.Open(nil, b[:g.NonceSize()], b[g.NonceSize():], []byte(aad))
}
func validID(id string) bool { _, err := uuid.Parse(id); return err == nil }
func nonempty(v ...string) bool {
	for _, s := range v {
		if strings.TrimSpace(s) == "" {
			return false
		}
	}
	return true
}
func oneOf(s string, values ...string) bool {
	for _, v := range values {
		if s == v {
			return true
		}
	}
	return false
}
func fields(v any) map[string]any {
	b, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}
func str(m map[string]any, k string) string { v, _ := m[k].(string); return v }
func number(m map[string]any, k string) int { v, _ := m[k].(float64); return int(v) }
func stringsAt(m map[string]any, k string) []string {
	out := []string{}
	if a, ok := m[k].([]any); ok {
		for _, v := range a {
			if s, ok := v.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}
func (s *Server) create(c echo.Context, kind, application string, body any) (map[string]any, error) {
	m := fields(body)
	id := uuid.NewString()
	b, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	var app any
	if application != "" {
		app = application
	}
	var at time.Time
	err = s.q(c).QueryRow(c.Request().Context(), "INSERT INTO resources(id,owner_id,kind,application_id,body) VALUES($1,$2,$3,$4,$5) RETURNING created_at", id, owner(c), kind, app, b).Scan(&at)
	if err != nil {
		return nil, err
	}
	m["id"] = id
	m["revision"] = float64(1)
	m["createdAt"] = at
	m["updatedAt"] = at
	if immutable(kind) {
		delete(m, "revision")
		delete(m, "updatedAt")
	}
	return m, nil
}
func scanResource(row pgx.Row) (map[string]any, error) {
	var id string
	var body []byte
	var rev int
	var created, updated time.Time
	if err := row.Scan(&id, &body, &rev, &created, &updated); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fail(404, "NOT_FOUND", "리소스를 찾을 수 없습니다")
		}
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, err
	}
	m["id"] = id
	m["revision"] = float64(rev)
	m["createdAt"] = created
	m["updatedAt"] = updated
	return m, nil
}
func (s *Server) get(c echo.Context, kind, id string) (map[string]any, error) {
	if !validID(id) {
		return nil, fail(404, "NOT_FOUND", "리소스를 찾을 수 없습니다")
	}
	m, e := scanResource(s.q(c).QueryRow(c.Request().Context(), "SELECT id,body,revision,created_at,updated_at FROM resources WHERE id=$1 AND owner_id=$2 AND kind=$3", id, owner(c), kind))
	if e == nil && immutable(kind) {
		delete(m, "revision")
		delete(m, "updatedAt")
	}
	return m, e
}
func (s *Server) list(c echo.Context, kind, application string) ([]any, error) {
	if application != "" && !validID(application) {
		return nil, invalid("applicationId가 유효하지 않습니다")
	}
	rows, err := s.q(c).Query(c.Request().Context(), "SELECT id,body,revision,created_at,updated_at FROM resources WHERE owner_id=$1 AND kind=$2 AND ($3='' OR application_id::text=$3) ORDER BY created_at DESC,id DESC", owner(c), kind, application)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		m, err := scanResource(rows)
		if err != nil {
			return nil, err
		}
		if immutable(kind) {
			delete(m, "revision")
			delete(m, "updatedAt")
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
func (s *Server) update(c echo.Context, kind string, m map[string]any, expected int) (map[string]any, error) {
	id := str(m, "id")
	body := map[string]any{}
	for k, v := range m {
		if !oneOf(k, "id", "revision", "createdAt", "updatedAt") {
			body[k] = v
		}
	}
	b, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	result, err := scanResource(s.q(c).QueryRow(c.Request().Context(), "UPDATE resources SET body=$1,revision=revision+1,updated_at=now() WHERE id=$2 AND owner_id=$3 AND kind=$4 AND revision=$5 RETURNING id,body,revision,created_at,updated_at", b, id, owner(c), kind, expected))
	if ae, ok := err.(*apiError); ok && ae.Status == 404 {
		return nil, fail(409, "REVISION_CONFLICT", "다른 변경이 저장되었습니다. 최신 버전을 불러오세요")
	}
	return result, err
}
func empty(c echo.Context) error {
	if c.Get("tx") != nil {
		c.Set("responseStatus", 204)
		c.Set("responseBody", nil)
		return nil
	}
	return c.NoContent(204)
}
func page(c echo.Context, items []any) error {
	limit := 50
	if value := c.QueryParam("limit"); value != "" {
		n, e := strconv.Atoi(value)
		if e != nil || n < 1 || n > 100 {
			return invalid("limit은 1~100입니다")
		}
		limit = n
	}
	start := 0
	if cursor := c.QueryParam("cursor"); cursor != "" {
		b, e := base64.RawURLEncoding.DecodeString(cursor)
		if e != nil {
			return invalid("cursor가 유효하지 않습니다")
		}
		found := false
		for i, item := range items {
			if str(item.(map[string]any), "id") == string(b) {
				start = i + 1
				found = true
				break
			}
		}
		if !found {
			return invalid("cursor가 유효하지 않습니다")
		}
	}
	end := start + limit
	if end > len(items) {
		end = len(items)
	}
	var cursor any
	if end < len(items) {
		cursor = base64.RawURLEncoding.EncodeToString([]byte(str(items[end-1].(map[string]any), "id")))
	}
	payload := map[string]any{"data": items[start:end], "page": map[string]any{"nextCursor": cursor, "hasMore": end < len(items)}}
	if c.Get("tx") != nil {
		c.Set("responseStatus", 200)
		c.Set("responseBody", payload)
		return nil
	}
	return c.JSON(200, payload)
}
func (s *Server) operation(c echo.Context, kind, app string, result any) error {
	v, e := s.create(c, "operations", app, map[string]any{"type": kind, "applicationId": nullable(app), "status": "SUCCEEDED", "progress": 100, "result": map[string]any{"kind": kind, "value": result}, "error": nil, "inputRequest": nil})
	if e != nil {
		return e
	}
	delete(v, "revision")
	return ok(c, 202, v)
}
func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}
func immutable(kind string) bool {
	return oneOf(kind, "versions", "analyses", "submission-drafts", "messages", "ai-usage", "ledger")
}

func errorDetails(c echo.Context) any {
	if v := c.Get("errorDetails"); v != nil {
		return v
	}
	return map[string]any{}
}

func httpErrorCode(status int) string {
	if code := map[int]string{400: "VALIDATION_ERROR", 401: "UNAUTHENTICATED", 403: "INSUFFICIENT_SCOPE", 404: "NOT_FOUND", 413: "PAYLOAD_TOO_LARGE", 429: "RATE_LIMITED", 503: "TEMPORARILY_UNAVAILABLE"}[status]; code != "" {
		return code
	}
	return "INTERNAL"
}
