package main

import (
	"encoding/json"
	"net/url"
	"time"
)

type CompanySource struct {
	SourceURL  string `json:"sourceUrl"`
	SourceText string `json:"sourceText"`
	AccessedAt string `json:"accessedAt"`
}

func validateCompanySources(sources []CompanySource) error {
	if len(sources) > 10 {
		return invalid("회사 출처는 최대 10개입니다")
	}
	for i := range sources {
		source := &sources[i]
		u, e := url.Parse(source.SourceURL)
		if e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || !length(source.SourceText, 1, 20000) {
			return invalid("회사 출처 URL·원문 오류")
		}
		at, e := time.Parse(time.RFC3339, source.AccessedAt)
		if e != nil || at.After(time.Now()) {
			return invalid("회사 출처 조회 시각 오류")
		}
		source.AccessedAt = at.UTC().Format(time.RFC3339Nano)
	}
	return nil
}
func companySources(v map[string]any) []CompanySource {
	sources := []CompanySource{}
	raw, _ := json.Marshal(v["companySources"])
	json.Unmarshal(raw, &sources)
	if sources == nil {
		return []CompanySource{}
	}
	return sources
}
func companyResearch(sources []CompanySource) []any {
	result := []any{}
	for _, source := range sources {
		result = append(result, map[string]any{"claim": source.SourceText, "sourceUrl": source.SourceURL, "accessedAt": source.AccessedAt, "verificationStatus": "USER_PROVIDED"})
	}
	return result
}
