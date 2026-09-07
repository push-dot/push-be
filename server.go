package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
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
	"os"
	"strings"
	"time"
)

type Config struct {
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
func invalid(message string) error                { return fail(400, "VALIDATION", message) }
func conflict(message string) error               { return fail(409, "CONFLICT", message) }
func NewServer(db *pgxpool.Pool, c Config) (*Server, error) {
	if len(c.AESKey) != 32 {
		return nil, errors.New("AES_KEY must contain 32 bytes")
	}
	if c.Environment != "development" && c.DevToken != "" {
		return nil, errors.New("DEV_AUTH_TOKEN is forbidden outside development")
	}
	schema, err := os.ReadFile("migrations/001_initial.sql")
	if err != nil {
		return nil, err
	}
	if _, err = db.Exec(context.Background(), string(schema)); err != nil {
		return nil, err
	}
	s := &Server{DB: db, Echo: echo.New(), Config: c, HTTP: &http.Client{Timeout: 30 * time.Second}}
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
			e = &apiError{he.Code, http.StatusText(he.Code), http.StatusText(he.Code)}
		}
		_ = c.JSON(e.Status, map[string]any{"error": map[string]string{"code": e.Code, "message": e.Message}})
	}
	s.Echo.Use(middleware.Recover(), middleware.BodyLimit("1M"), middleware.Secure(), middleware.CORSWithConfig(middleware.CORSConfig{AllowOrigins: []string{"http://localhost:5173", "http://127.0.0.1:5173", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"}, AllowMethods: []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}, AllowHeaders: []string{"Authorization", "Content-Type"}}))
	s.Echo.GET("/healthz", func(c echo.Context) error { return c.JSON(200, map[string]string{"status": "ok"}) })
	s.Echo.GET("/readyz", func(c echo.Context) error {
		if err := db.Ping(c.Request().Context()); err != nil {
			return fail(503, "UNAVAILABLE", "database unavailable")
		}
		return c.JSON(200, map[string]string{"status": "ready"})
	})
	s.authRoutes()
	g := s.Echo.Group("/api/v1", s.authenticate)
	s.domainRoutes(g)
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
			return fail(401, "UNAUTHORIZED", "로그인이 필요합니다")
		}
		user := ""
		if s.Config.Environment == "development" && s.Config.DevToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(s.Config.DevToken)) == 1 {
			user = "00000000-0000-4000-8000-000000000001"
		} else {
			if err := s.DB.QueryRow(c.Request().Context(), "SELECT user_id FROM sessions WHERE access_hash=$1 AND access_expires>now()", hash(token)).Scan(&user); err != nil {
				return fail(401, "UNAUTHORIZED", "토큰이 만료되었거나 유효하지 않습니다")
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
		err = next(c)
		if err != nil {
			return err
		}
		if err = tx.Commit(c.Request().Context()); err != nil {
			return err
		}
		if status, ok := c.Get("responseStatus").(int); ok {
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
	return scanResource(s.q(c).QueryRow(c.Request().Context(), "SELECT id,body,revision,created_at,updated_at FROM resources WHERE id=$1 AND owner_id=$2 AND kind=$3", id, owner(c), kind))
}
func (s *Server) list(c echo.Context, kind, application string) ([]any, error) {
	if application != "" && !validID(application) {
		return nil, invalid("applicationId가 유효하지 않습니다")
	}
	rows, err := s.q(c).Query(c.Request().Context(), "SELECT id,body,revision,created_at,updated_at FROM resources WHERE owner_id=$1 AND kind=$2 AND ($3='' OR application_id::text=$3) ORDER BY created_at,id LIMIT 1000", owner(c), kind, application)
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
		return nil, conflict("다른 변경이 저장되었습니다. 최신 버전을 불러오세요")
	}
	return result, err
}
func (s *Server) approved(c echo.Context, kind, target string) bool {
	var found bool
	err := s.q(c).QueryRow(c.Request().Context(), "SELECT EXISTS(SELECT 1 FROM resources WHERE owner_id=$1 AND kind='approvals' AND body->>'kind'=$2 AND body->>'targetId'=$3 AND body->>'status'='APPROVED')", owner(c), kind, target).Scan(&found)
	return err == nil && found
}
func (s *Server) requireApproval(c echo.Context, kind, target string) error {
	if !s.approved(c, kind, target) {
		return fail(409, "APPROVAL_REQUIRED", "사용자 승인이 필요합니다")
	}
	return nil
}
