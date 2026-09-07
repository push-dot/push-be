package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/labstack/echo/v4"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func (s *Server) stripeWebhook(c echo.Context) error {
	if s.Config.StripeWebhookSecret == "" {
		return fail(503, "NOT_CONFIGURED", "Stripe webhook secret이 필요합니다")
	}
	body, e := io.ReadAll(io.LimitReader(c.Request().Body, 1<<20))
	if e != nil {
		return invalid("webhook body 오류")
	}
	timestamp := int64(0)
	signatures := []string{}
	for _, part := range strings.Split(c.Request().Header.Get("Stripe-Signature"), ",") {
		pair := strings.SplitN(part, "=", 2)
		if len(pair) != 2 {
			continue
		}
		if pair[0] == "t" {
			timestamp, _ = strconv.ParseInt(pair[1], 10, 64)
		}
		if pair[0] == "v1" {
			signatures = append(signatures, pair[1])
		}
	}
	now := time.Now().Unix()
	if timestamp < now-300 || timestamp > now+300 {
		return invalid("webhook 서명 시각 오류")
	}
	h := hmac.New(sha256.New, []byte(s.Config.StripeWebhookSecret))
	h.Write([]byte(strconv.FormatInt(timestamp, 10) + "."))
	h.Write(body)
	valid := false
	for _, signature := range signatures {
		b, e := hex.DecodeString(signature)
		if e == nil && hmac.Equal(h.Sum(nil), b) {
			valid = true
		}
	}
	if !valid {
		return invalid("webhook 서명 오류")
	}
	var event struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Created int64  `json:"created"`
		Data    struct {
			Object map[string]any `json:"object"`
		} `json:"data"`
	}
	if e = json.Unmarshal(body, &event); e != nil || event.ID == "" {
		return invalid("webhook event 오류")
	}
	tx, e := s.DB.Begin(c.Request().Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(context.Background())
	tag, e := tx.Exec(c.Request().Context(), "INSERT INTO billing_events(id) VALUES($1) ON CONFLICT DO NOTHING", event.ID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		return ok(c, 200, map[string]bool{"received": true})
	}
	obj := event.Data.Object
	customer := str(obj, "customer")
	if customer != "" {
		var user string
		var balance int64
		var active bool
		var last int64
		e = tx.QueryRow(c.Request().Context(), "SELECT owner_id,credits,active,last_event_time FROM billing WHERE customer_id=$1 FOR UPDATE", customer).Scan(&user, &balance, &active, &last)
		if e == nil {
			if event.Created >= last {
				period := stripePeriodEnd(obj)
				if period > 0 {
					if _, e = tx.Exec(c.Request().Context(), "UPDATE billing SET period_ends_at=$2 WHERE owner_id=$1", user, time.Unix(int64(period), 0).UTC()); e != nil {
						return e
					}
				}
			}
			switch event.Type {
			case "invoice.paid":
				if str(obj, "subscription") == "" {
					if p, ok := obj["parent"].(map[string]any); !ok || p["subscription_details"] == nil {
						break
					}
				}
				if str(obj, "currency") != "usd" {
					break
				}
				amount := number(obj, "amount_paid")
				if amount <= 0 || amount > 10000000 {
					break
				}
				grant := int64(amount) * 10000
				balance += grant
				if _, e = tx.Exec(c.Request().Context(), "UPDATE billing SET credits=$2,active=CASE WHEN $3>=last_event_time THEN true ELSE active END,last_event_time=GREATEST(last_event_time,$3) WHERE owner_id=$1", user, balance, event.Created); e != nil {
					return e
				}
				c.Set("owner", user)
				c.Set("tx", tx)
				if _, e = s.create(c, "ledger", "", map[string]any{"type": "PAYMENT", "amountMicroCredits": grant, "balanceAfter": balance, "referenceId": event.ID}); e != nil {
					return e
				}
				c.Set("tx", nil)
			case "customer.subscription.deleted", "customer.subscription.updated", "invoice.payment_failed":
				status := event.Type == "customer.subscription.updated" && oneOf(str(obj, "status"), "active", "trialing")
				if event.Created >= last {
					if _, e = tx.Exec(c.Request().Context(), "UPDATE billing SET active=$2,last_event_time=$3 WHERE owner_id=$1", user, status, event.Created); e != nil {
						return e
					}
				}
			case "charge.refunded":
				if str(obj, "currency") != "usd" {
					break
				}
				refunded := int64(number(obj, "amount_refunded"))
				if refunded < 0 {
					break
				}
				var prior int64
				_ = tx.QueryRow(c.Request().Context(), "SELECT amount FROM stripe_refunds WHERE charge_id=$1", str(obj, "id")).Scan(&prior)
				if refunded > prior {
					debit := (refunded - prior) * 10000
					balance -= debit
					if _, e = tx.Exec(c.Request().Context(), "UPDATE billing SET credits=$2 WHERE owner_id=$1", user, balance); e != nil {
						return e
					}
					if _, e = tx.Exec(c.Request().Context(), "INSERT INTO stripe_refunds(charge_id,amount) VALUES($1,$2) ON CONFLICT(charge_id) DO UPDATE SET amount=$2", str(obj, "id"), refunded); e != nil {
						return e
					}
					c.Set("owner", user)
					c.Set("tx", tx)
					if _, e = s.create(c, "ledger", "", map[string]any{"type": "REFUND", "amountMicroCredits": -debit, "balanceAfter": balance, "referenceId": event.ID}); e != nil {
						return e
					}
					c.Set("tx", nil)
				}
			}
		} else if e.Error() != "no rows in result set" {
			return e
		}
	}
	if e = tx.Commit(c.Request().Context()); e != nil {
		return e
	}
	return ok(c, 200, map[string]bool{"received": true})
}
func (s *Server) billingRoutes(g *echo.Group) {
	g.GET("/billing", func(c echo.Context) error {
		var active bool
		var balance, reserved int64
		var period *time.Time
		e := s.q(c).QueryRow(c.Request().Context(), "SELECT active,credits,reserved,period_ends_at FROM billing WHERE owner_id=$1", owner(c)).Scan(&active, &balance, &reserved, &period)
		if e != nil && e.Error() != "no rows in result set" {
			return e
		}
		if period != nil {
			utc := period.UTC()
			period = &utc
		}
		status := "INACTIVE"
		if active {
			status = "ACTIVE"
		}
		return ok(c, 200, map[string]any{"subscriptionStatus": status, "plan": nullable(s.Config.StripePriceID), "periodEndsAt": period, "balanceMicroCredits": balance, "reservedMicroCredits": reserved})
	})
	g.GET("/billing/ledger", func(c echo.Context) error {
		v, e := s.list(c, "ledger", "")
		if e != nil {
			return e
		}
		return page(c, v)
	})
	g.POST("/billing/checkout", func(c echo.Context) error {
		var in struct {
			PlanID string `json:"planId"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if s.Config.StripeSecret == "" || s.Config.StripePriceID == "" || !validURL(s.Config.CheckoutSuccessURL) || s.Config.CheckoutSuccessURL == "" || s.Config.CheckoutCancelURL == "" {
			return fail(503, "NOT_CONFIGURED", "Stripe Checkout 설정이 필요합니다")
		}
		if in.PlanID != "managed" {
			return invalid("planId가 허용되지 않습니다")
		}
		var customer string
		_ = s.q(c).QueryRow(c.Request().Context(), "SELECT customer_id FROM billing WHERE owner_id=$1", owner(c)).Scan(&customer)
		headers := map[string]string{"Authorization": "Bearer " + s.Config.StripeSecret, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": owner(c) + ":" + c.Request().Header.Get("Idempotency-Key")}
		if customer == "" {
			headers["Idempotency-Key"] = owner(c) + ":customer"
			v, e := s.providerRequest(c.Request().Context(), "POST", "https://api.stripe.com/v1/customers", strings.NewReader(url.Values{"metadata[push_user_id]": {owner(c)}}.Encode()), headers)
			if e != nil {
				return e
			}
			customer = str(v, "id")
			if customer == "" {
				return fail(502, "PROVIDER_ERROR", "Stripe customer 누락")
			}
			if _, e = s.q(c).Exec(c.Request().Context(), "INSERT INTO billing(owner_id,customer_id) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET customer_id=$2", owner(c), customer); e != nil {
				return e
			}
		}
		headers["Idempotency-Key"] = owner(c) + ":" + c.Request().Header.Get("Idempotency-Key")
		v, e := s.providerRequest(c.Request().Context(), "POST", "https://api.stripe.com/v1/checkout/sessions", strings.NewReader(url.Values{"customer": {customer}, "mode": {"subscription"}, "line_items[0][price]": {s.Config.StripePriceID}, "line_items[0][quantity]": {"1"}, "success_url": {s.Config.CheckoutSuccessURL}, "cancel_url": {s.Config.CheckoutCancelURL}}.Encode()), headers)
		if e != nil {
			return e
		}
		if !validURL(str(v, "url")) || str(v, "url") == "" {
			return fail(502, "PROVIDER_ERROR", "Checkout URL 누락")
		}
		return ok(c, 200, map[string]any{"url": v["url"], "expiresAt": time.Unix(int64(number(v, "expires_at")), 0).UTC()})
	})
	g.POST("/billing/portal", func(c echo.Context) error {
		var in struct{}
		if e := decode(c, &in); e != nil {
			return e
		}
		if s.Config.StripeSecret == "" || s.Config.CheckoutSuccessURL == "" {
			return fail(503, "NOT_CONFIGURED", "Stripe 설정이 필요합니다")
		}
		var customer string
		if e := s.q(c).QueryRow(c.Request().Context(), "SELECT customer_id FROM billing WHERE owner_id=$1", owner(c)).Scan(&customer); e != nil || customer == "" {
			return fail(409, "INTEGRATION_REQUIRED", "결제 계정이 없습니다")
		}
		v, e := s.providerRequest(c.Request().Context(), "POST", "https://api.stripe.com/v1/billing_portal/sessions", strings.NewReader(url.Values{"customer": {customer}, "return_url": {s.Config.CheckoutSuccessURL}}.Encode()), map[string]string{"Authorization": "Bearer " + s.Config.StripeSecret, "Content-Type": "application/x-www-form-urlencoded"})
		if e != nil {
			return e
		}
		return ok(c, 200, map[string]any{"url": v["url"]})
	})
}

func (s *Server) recordLedger(c echo.Context, kind string, amount int64, reference string) error {
	var balance int64
	if e := s.q(c).QueryRow(c.Request().Context(), "SELECT credits FROM billing WHERE owner_id=$1", owner(c)).Scan(&balance); e != nil {
		return e
	}
	_, e := s.create(c, "ledger", "", map[string]any{"type": kind, "amountMicroCredits": amount, "balanceAfter": balance, "referenceId": reference})
	return e
}

func stripePeriodEnd(object map[string]any) int {
	period := number(object, "current_period_end")
	if period == 0 {
		period = number(object, "period_end")
	}
	for _, key := range []string{"items", "lines"} {
		container, _ := object[key].(map[string]any)
		items, _ := container["data"].([]any)
		for _, raw := range items {
			item, _ := raw.(map[string]any)
			end := number(item, "current_period_end")
			nested, _ := item["period"].(map[string]any)
			if end == 0 {
				end = number(nested, "end")
			}
			if end > period {
				period = end
			}
		}
	}
	return period
}
