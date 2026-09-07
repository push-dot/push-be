package main

import (
	"context"
	"encoding/base64"
	"github.com/jackc/pgx/v5/pgxpool"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	key, err := base64.StdEncoding.DecodeString(os.Getenv("AES_KEY"))
	if err != nil || len(key) != 32 {
		log.Fatal("AES_KEY must be base64-encoded 32 bytes")
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL required")
	}
	db, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		log.Fatal("database configuration invalid")
	}
	defer db.Close()
	s, err := NewServer(db, Config{Environment: os.Getenv("APP_ENV"), DevToken: os.Getenv("DEV_AUTH_TOKEN"), AESKey: key, PublicURL: os.Getenv("PUBLIC_API_URL"), GoogleClientID: os.Getenv("GOOGLE_CLIENT_ID"), GoogleClientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"), GitHubClientID: os.Getenv("GITHUB_CLIENT_ID"), GitHubClientSecret: os.Getenv("GITHUB_CLIENT_SECRET"), GoogleBeta: os.Getenv("GOOGLE_GMAIL_BETA_ENABLED") == "true", StripeSecret: os.Getenv("STRIPE_SECRET_KEY"), StripeWebhookSecret: os.Getenv("STRIPE_WEBHOOK_SECRET"), StripePriceID: os.Getenv("STRIPE_PRICE_ID"), CheckoutSuccessURL: os.Getenv("CHECKOUT_SUCCESS_URL"), CheckoutCancelURL: os.Getenv("CHECKOUT_CANCEL_URL"), OpenAIKey: os.Getenv("OPENAI_API_KEY")})
	if err != nil {
		log.Fatal(err)
	}
	address := os.Getenv("LISTEN_ADDR")
	if address == "" {
		address = ":8080"
	}
	go func() {
		if e := s.Echo.Start(address); e != nil {
			log.Print("HTTP server stopped")
		}
	}()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = s.Echo.Shutdown(shutdown)
}
