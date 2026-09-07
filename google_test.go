package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGooglePaginationFailurePreservesCheckpoint(t *testing.T) {
	s := testApp(t)
	s.Config.GoogleBeta = true
	secret, e := s.encrypt([]byte("refresh-test"), "00000000-0000-4000-8000-000000000001:google")
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.DB.Exec(context.Background(), "INSERT INTO google_connections(owner_id,ciphertext,scopes) VALUES('00000000-0000-4000-8000-000000000001',$1,'[\"https://www.googleapis.com/auth/calendar.readonly\",\"https://www.googleapis.com/auth/gmail.readonly\"]')", secret)
	if e != nil {
		t.Fatal(e)
	}
	failSecond := true
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			json.NewEncoder(w).Encode(map[string]any{"access_token": "access-test"})
		case "/gmail/v1/users/me/profile":
			json.NewEncoder(w).Encode(map[string]any{"historyId": "123"})
		case "/gmail/v1/users/me/messages":
			json.NewEncoder(w).Encode(map[string]any{"messages": []any{}})
		case "/calendar/v3/calendars/primary/events":
			if r.URL.Query().Get("pageToken") == "page2" {
				if failSecond {
					http.Error(w, "temporary", 500)
					return
				}
				json.NewEncoder(w).Encode(map[string]any{"items": []any{}, "nextSyncToken": "next-token"})
			} else {
				json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{"id": "event1", "summary": "면접", "start": map[string]any{"dateTime": "2026-10-01T01:00:00Z"}, "end": map[string]any{"dateTime": "2026-10-01T02:00:00Z"}}}, "nextPageToken": "page2"})
			}
		default:
			http.Error(w, "unknown", 404)
		}
	}))
	defer provider.Close()
	s.HTTP = &http.Client{Transport: redirectTransport{target: provider.Listener.Addr().String()}}
	request(t, s, "POST", "/integrations/google/sync", map[string]any{}, 502)
	var cursor string
	s.DB.QueryRow(context.Background(), "SELECT calendar_sync FROM google_connections").Scan(&cursor)
	if cursor != "" {
		t.Fatal("cursor advanced on partial failure")
	}
	failSecond = false
	result := opResult(t, request(t, s, "POST", "/integrations/google/sync", map[string]any{}, 202)).(map[string]any)
	if result["eventsUpserted"] != float64(1) {
		t.Fatal(result)
	}
	s.DB.QueryRow(context.Background(), "SELECT calendar_sync FROM google_connections").Scan(&cursor)
	if cursor != "next-token" {
		t.Fatal("cursor not committed")
	}
}
