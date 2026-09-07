package main

import (
	"github.com/labstack/echo/v4"
	"strconv"
	"time"
)

func timeField(v any) (time.Time, error) {
	if at, ok := v.(time.Time); ok {
		return at, nil
	}
	if text, ok := v.(string); ok {
		return time.Parse(time.RFC3339Nano, text)
	}
	return time.Time{}, invalid("시각을 읽을 수 없습니다")
}
func filterRequested(c echo.Context, kind string, items []any) ([]any, error) {
	var from, to *time.Time
	for field, target := range map[string]**time.Time{"from": &from, "to": &to} {
		if value := c.QueryParam(field); value != "" {
			at, e := time.Parse(time.RFC3339, value)
			if e != nil {
				return nil, invalid(field + " 시각 오류")
			}
			*target = &at
		}
	}
	if from != nil && to != nil && (!to.After(*from) || kind == "calendar-events" && to.Sub(*from) > 366*24*time.Hour) {
		return nil, invalid("조회 기간 오류")
	}
	var archived *bool
	if value := c.QueryParam("archived"); value != "" {
		flag, e := strconv.ParseBool(value)
		if e != nil {
			return nil, invalid("archived는 boolean입니다")
		}
		archived = &flag
	}
	out := []any{}
	for _, raw := range items {
		v := raw.(map[string]any)
		if archived != nil {
			flag, _ := v["archived"].(bool)
			if flag != *archived {
				continue
			}
		}
		if from != nil || to != nil {
			field := "createdAt"
			if kind == "interviews" {
				field = "scheduledAt"
			}
			if kind == "calendar-events" {
				field = "startsAt"
			}
			at, e := timeField(v[field])
			if e != nil {
				return nil, e
			}
			end := at
			if kind == "calendar-events" {
				end, e = timeField(v["endsAt"])
				if e != nil {
					return nil, e
				}
			}
			if from != nil && (kind == "calendar-events" && !end.After(*from) || kind != "calendar-events" && at.Before(*from)) {
				continue
			}
			if to != nil && !at.Before(*to) {
				continue
			}
		}
		out = append(out, v)
	}
	return out, nil
}
