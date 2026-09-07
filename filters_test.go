package main

import "testing"

func TestListFiltersUseRequestedTimeRange(t *testing.T) {
	s := testApp(t)
	_, a := jobApp(t, s)
	for _, at := range []string{"2026-10-01T09:00:00Z", "2026-11-01T09:00:00Z"} {
		request(t, s, "POST", "/interviews", map[string]any{"applicationId": id(a), "title": "면접", "scheduledAt": at, "evidenceIds": []string{}}, 201)
	}
	result := request(t, s, "GET", "/interviews?from=2026-10-01T00:00:00Z&to=2026-10-31T23:59:59Z", nil, 200)
	if len(result["data"].([]any)) != 1 {
		t.Fatal("time filter ignored", result)
	}
	request(t, s, "GET", "/interviews?from=invalid", nil, 400)
}
