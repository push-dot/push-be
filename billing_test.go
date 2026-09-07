package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func signedBillingEvent(t *testing.T, s *Server, event map[string]any) {
	t.Helper()
	s.Config.StripeWebhookSecret = "test-secret"
	raw, _ := json.Marshal(event)
	now := time.Now().Unix()
	h := hmac.New(sha256.New, []byte(s.Config.StripeWebhookSecret))
	h.Write([]byte(strconv.FormatInt(now, 10) + "."))
	h.Write(raw)
	req := httptest.NewRequest("POST", "/api/v1/billing/webhook", bytes.NewReader(raw))
	req.Header.Set("Stripe-Signature", fmt.Sprintf("t=%d,v1=%s", now, hex.EncodeToString(h.Sum(nil))))
	w := httptest.NewRecorder()
	s.Echo.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}
func TestRefundDuringReservationConservesCredits(t *testing.T) {
	for _, cancel := range []bool{true, false} {
		t.Run(fmt.Sprint(cancel), func(t *testing.T) {
			s := testApp(t)
			_, app := jobApp(t, s)
			s.Config.Models = []ModelConfig{{Provider: "OPENAI", Model: "test", Managed: true, InputRate: 2, OutputRate: 3}}
			s.Config.OpenAIKey = "key"
			_, e := s.DB.Exec(context.Background(), "INSERT INTO billing(owner_id,customer_id,active,credits) VALUES('00000000-0000-4000-8000-000000000001','cus_test',true,100000)")
			if e != nil {
				t.Fatal(e)
			}
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "answer"}}}, "usage": map[string]any{"prompt_tokens": 20, "completion_tokens": 8}})
			}))
			defer provider.Close()
			s.HTTP = &http.Client{Transport: redirectTransport{target: provider.Listener.Addr().String()}}
			op := data(request(t, s, "POST", "/ai/generate", map[string]any{"ai": map[string]any{"provider": "OPENAI", "model": "test", "credentialMode": "MANAGED", "effort": "LOW"}, "prompt": "test", "applicationId": id(app), "evidenceIds": []string{}}, 202))
			event := map[string]any{"id": "evt_refund", "type": "charge.refunded", "data": map[string]any{"object": map[string]any{"id": "ch_test", "customer": "cus_test", "currency": "usd", "amount_refunded": 10}}}
			signedBillingEvent(t, s, event)
			event["id"] = "evt_refund_duplicate_amount"
			signedBillingEvent(t, s, event)
			if cancel {
				request(t, s, "POST", "/operations/"+id(op)+"/cancel", map[string]any{}, 200)
			} else if e = s.ProcessOne(context.Background()); e != nil {
				t.Fatal(e)
			}
			var balance, reserved, total int64
			s.DB.QueryRow(context.Background(), "SELECT credits,reserved FROM billing").Scan(&balance, &reserved)
			s.DB.QueryRow(context.Background(), "SELECT sum((body->>'amountMicroCredits')::bigint) FROM resources WHERE kind='ledger'").Scan(&total)
			want := int64(-64)
			if cancel {
				want = 0
			}
			if balance != want || reserved != 0 || total != want-100000 {
				t.Fatalf("created credits: balance=%d reserved=%d delta=%d", balance, reserved, total)
			}
		})
	}
}
func TestNestedStripePeriod(t *testing.T) {
	s := testApp(t)
	s.DB.Exec(context.Background(), "INSERT INTO billing(owner_id,customer_id) VALUES('00000000-0000-4000-8000-000000000001','cus_test')")
	for _, kind := range []string{"customer.subscription.updated", "invoice.paid"} {
		object := map[string]any{"customer": "cus_test", "status": "active", "subscription": "sub", "amount_paid": 100, "currency": "usd"}
		if kind == "invoice.paid" {
			object["lines"] = map[string]any{"data": []any{map[string]any{"period": map[string]any{"end": 1800000000}}}}
		} else {
			object["items"] = map[string]any{"data": []any{map[string]any{"current_period_end": 1800000000}}}
		}
		signedBillingEvent(t, s, map[string]any{"id": kind, "type": kind, "created": 1, "data": map[string]any{"object": object}})
		result := data(request(t, s, "GET", "/billing", nil, 200))
		if result["periodEndsAt"] != time.Unix(1800000000, 0).UTC().Format(time.RFC3339) {
			t.Fatal(result)
		}
		s.DB.Exec(context.Background(), "UPDATE billing SET period_ends_at=NULL")
	}
}

func TestSameSecondCancellationNeverResurrectsFromPayment(t *testing.T) {
	for _, paymentFirst := range []bool{true, false} {
		t.Run(fmt.Sprint(paymentFirst), func(t *testing.T) {
			s := testApp(t)
			_, e := s.DB.Exec(context.Background(), "INSERT INTO billing(owner_id,customer_id,active) VALUES('00000000-0000-4000-8000-000000000001','cus_test',true)")
			if e != nil {
				t.Fatal(e)
			}
			paid := map[string]any{"id": "evt_paid_equal", "type": "invoice.paid", "created": 1800000000, "data": map[string]any{"object": map[string]any{"id": "in_test", "customer": "cus_test", "subscription": "sub_test", "currency": "usd", "amount_paid": 100}}}
			deleted := map[string]any{"id": "evt_deleted_equal", "type": "customer.subscription.deleted", "created": 1800000000, "data": map[string]any{"object": map[string]any{"id": "sub_test", "customer": "cus_test", "status": "canceled"}}}
			if paymentFirst {
				signedBillingEvent(t, s, paid)
				signedBillingEvent(t, s, deleted)
			} else {
				signedBillingEvent(t, s, deleted)
				signedBillingEvent(t, s, paid)
			}
			signedBillingEvent(t, s, paid)
			result := data(request(t, s, "GET", "/billing", nil, 200))
			if result["subscriptionStatus"] != "INACTIVE" || result["balanceMicroCredits"] != float64(1000000) {
				t.Fatal(result)
			}
			active := map[string]any{"id": "evt_updated_equal", "type": "customer.subscription.updated", "created": 1800000000, "data": map[string]any{"object": map[string]any{"id": "sub_test", "customer": "cus_test", "status": "active"}}}
			signedBillingEvent(t, s, active)
			result = data(request(t, s, "GET", "/billing", nil, 200))
			if result["subscriptionStatus"] != "INACTIVE" {
				t.Fatal("same-second active update resurrected", result)
			}
			active["id"] = "evt_updated_newer"
			active["created"] = 1800000001
			signedBillingEvent(t, s, active)
			result = data(request(t, s, "GET", "/billing", nil, 200))
			if result["subscriptionStatus"] != "ACTIVE" {
				t.Fatal("new subscription state ignored", result)
			}
		})
	}
}
