package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func publicRequest(t *testing.T, s *Server, path string, body any, status int) map[string]any {
	t.Helper()
	b, _ := json.Marshal(body)
	r := httptest.NewRequest("POST", "/api/v1"+path, bytes.NewReader(b))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.Echo.ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("%s: want %d got %d %s", path, status, w.Code, w.Body.String())
	}
	if status == 204 {
		return nil
	}
	var result map[string]any
	json.Unmarshal(w.Body.Bytes(), &result)
	return result
}
func TestOAuthExchangePKCESingleUseRefreshAndLogout(t *testing.T) {
	s := testApp(t)
	verifier := strings.Repeat("a", 43)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	user := "00000000-0000-4000-8000-000000000123"
	_, err := s.DB.Exec(context.Background(), "INSERT INTO auth_codes(code_hash,user_id,challenge,expires_at) VALUES($1,$2,$3,now()+interval '1 minute')", hash("one-time"), user, challenge)
	if err != nil {
		t.Fatal(err)
	}
	publicRequest(t, s, "/auth/exchange", map[string]any{"code": "one-time", "codeVerifier": strings.Repeat("b", 43)}, 401)
	tokens := data(publicRequest(t, s, "/auth/exchange", map[string]any{"code": "one-time", "codeVerifier": verifier}, 200))
	publicRequest(t, s, "/auth/exchange", map[string]any{"code": "one-time", "codeVerifier": verifier}, 401)
	rotated := data(publicRequest(t, s, "/auth/refresh", map[string]any{"refreshToken": tokens["refreshToken"]}, 200))
	publicRequest(t, s, "/auth/refresh", map[string]any{"refreshToken": tokens["refreshToken"]}, 401)
	r := httptest.NewRequest("GET", "/api/v1/auth/me", nil)
	r.Header.Set("Authorization", "Bearer "+tokens["accessToken"].(string))
	w := httptest.NewRecorder()
	s.Echo.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("rotated access token remains valid")
	}
	publicRequest(t, s, "/auth/logout", map[string]any{"refreshToken": rotated["refreshToken"]}, 204)
	publicRequest(t, s, "/auth/refresh", map[string]any{"refreshToken": rotated["refreshToken"]}, 401)
}
func TestStripeSignatureIdempotencyAndCreditGrant(t *testing.T) {
	s := testApp(t)
	s.Config.StripeWebhookSecret = "whsec_test"
	user := "00000000-0000-4000-8000-000000000001"
	_, err := s.DB.Exec(context.Background(), "INSERT INTO billing(owner_id,customer_id) VALUES($1,'cus_test')", user)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{"id":"evt_paid","type":"invoice.paid","data":{"object":{"customer":"cus_test","subscription":"sub_test","amount_paid":1000,"currency":"usd"}}}`)
	send := func(stamp int64, signature string, want int) {
		t.Helper()
		r := httptest.NewRequest("POST", "/api/v1/billing/webhook", bytes.NewReader(payload))
		r.Header.Set("Stripe-Signature", fmt.Sprintf("t=%d,v1=%s", stamp, signature))
		w := httptest.NewRecorder()
		s.Echo.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("webhook want %d got %d %s", want, w.Code, w.Body.String())
		}
	}
	sign := func(stamp int64) string {
		h := hmac.New(sha256.New, []byte("whsec_test"))
		h.Write([]byte(strconv.FormatInt(stamp, 10) + "."))
		h.Write(payload)
		return hex.EncodeToString(h.Sum(nil))
	}
	now := time.Now().Unix()
	send(now, "bad", 400)
	send(now-600, sign(now-600), 400)
	send(now, sign(now), 200)
	send(now, sign(now), 200)
	var credits int64
	var active bool
	if err = s.DB.QueryRow(context.Background(), "SELECT credits,active FROM billing WHERE owner_id=$1", user).Scan(&credits, &active); err != nil {
		t.Fatal(err)
	}
	if credits != 10000000 || !active {
		t.Fatalf("duplicate grant or missed active subscription: %d %v", credits, active)
	}
}
