package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/jackc/pgx/v5/pgxpool"
	"log"
	"os"
	"os/signal"
	"strconv"
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
	models := []ModelConfig{}
	if raw := os.Getenv("AI_MODELS"); raw != "" {
		if e := json.Unmarshal([]byte(raw), &models); e != nil {
			log.Fatal("AI_MODELS JSON invalid")
		}
	}
	workflowID, _ := strconv.Atoi(os.Getenv("GITHUB_VERIFICATION_WORKFLOW_ID"))
	s, err := NewServer(db, Config{GitHubVerificationToken: os.Getenv("GITHUB_VERIFICATION_TOKEN"), GitHubWorkflowID: workflowID, Models: models, Environment: os.Getenv("APP_ENV"), DevToken: os.Getenv("DEV_AUTH_TOKEN"), AESKey: key, PublicURL: os.Getenv("PUBLIC_API_URL"), GoogleClientID: os.Getenv("GOOGLE_CLIENT_ID"), GoogleClientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"), GitHubClientID: os.Getenv("GITHUB_CLIENT_ID"), GitHubClientSecret: os.Getenv("GITHUB_CLIENT_SECRET"), GoogleBeta: os.Getenv("GOOGLE_GMAIL_BETA_ENABLED") == "true", StripeSecret: os.Getenv("STRIPE_SECRET_KEY"), StripeWebhookSecret: os.Getenv("STRIPE_WEBHOOK_SECRET"), StripePriceID: os.Getenv("STRIPE_PRICE_ID"), CheckoutSuccessURL: os.Getenv("CHECKOUT_SUCCESS_URL"), CheckoutCancelURL: os.Getenv("CHECKOUT_CANCEL_URL"), OpenAIKey: os.Getenv("OPENAI_API_KEY")})
	if err != nil {
		log.Fatal(err)
	}
	go func() {
		for {
			if e := s.ProcessOne(context.Background()); e != nil {
				log.Print("background operation processing failed")
			}
			time.Sleep(time.Second)
		}
	}()
	address := os.Getenv("LISTEN_ADDR")
	if address == "" {
		address = ":8080"
	}
	go func() {
		if e := s.Echo.Start(address); e != nil {
			if e.Error() != "http: Server closed" {
				log.Fatal("HTTP listener failed")
			}
		}
	}()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = s.Echo.Shutdown(shutdown)
}
