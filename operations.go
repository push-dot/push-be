package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/labstack/echo/v4"
	"strconv"
	"strings"
	"time"
)

func (s *Server) streamOperation(c echo.Context) error {
	op, e := s.get(c, "operations", c.Param("id"))
	if e != nil {
		return e
	}
	after := int64(0)
	if last := c.Request().Header.Get("Last-Event-ID"); last != "" {
		parts := strings.Split(last, ":")
		if len(parts) != 2 || parts[0] != c.Param("id") {
			return invalid("Last-Event-ID 작업이 다릅니다")
		}
		after, e = strconv.ParseInt(parts[1], 10, 64)
		if e != nil || after < 0 {
			return invalid("Last-Event-ID 오류")
		}
	}
	var latest int64
	if e = s.q(c).QueryRow(c.Request().Context(), "SELECT COALESCE(MAX(sequence),0) FROM operation_events WHERE operation_id=$1 AND owner_id=$2", c.Param("id"), owner(c)).Scan(&latest); e != nil {
		return e
	}
	if after > latest {
		return invalid("Last-Event-ID가 작업 이력보다 큽니다")
	}
	c.Response().Header().Set("Content-Type", "text/event-stream")
	c.Response().Header().Set("Cache-Control", "no-cache")
	c.Response().Header().Set("X-Accel-Buffering", "no")
	c.Response().WriteHeader(200)
	ctx, cancel := context.WithTimeout(c.Request().Context(), 55*time.Second)
	defer cancel()
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		rows, e := s.DB.Query(ctx, "SELECT sequence,event_type,payload FROM operation_events WHERE owner_id=$1 AND operation_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 100", owner(c), c.Param("id"), after)
		if e != nil {
			if ctx.Err() != nil {
				return nil
			}
			return e
		}
		count := 0
		terminal := false
		for rows.Next() {
			var sequence int64
			var kind string
			var raw []byte
			if e = rows.Scan(&sequence, &kind, &raw); e != nil {
				rows.Close()
				return e
			}
			var payload any
			if e = json.Unmarshal(raw, &payload); e != nil {
				rows.Close()
				return e
			}
			data, _ := json.Marshal(map[string]any{"operationId": c.Param("id"), "sequence": sequence, "payload": payload})
			if _, e = fmt.Fprintf(c.Response(), "id: %s:%d\nevent: %s\ndata: %s\n\n", c.Param("id"), sequence, kind, data); e != nil {
				rows.Close()
				return nil
			}
			after = sequence
			count++
			terminal = oneOf(kind, "result", "error")
			if kind == "progress" {
				m, _ := payload.(map[string]any)
				terminal = oneOf(str(m, "status"), "CANCELLED", "NEEDS_INPUT")
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		if count > 0 {
			c.Response().Flush()
		}
		if terminal {
			return nil
		}
		if count == 100 {
			continue
		}
		if oneOf(str(op, "status"), "SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_INPUT") && after >= latest {
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
		}
	}
}
func (s *Server) RecoverWork(ctx context.Context) error {
	_, e := s.DB.Exec(ctx, `WITH recovered AS (UPDATE work_queue SET state=CASE WHEN dispatch_started_at IS NULL THEN 'QUEUED' ELSE 'UNKNOWN' END,lease_until=NULL WHERE state='RUNNING' AND COALESCE(lease_until,started_at+interval '5 minutes')<now() RETURNING operation_id,state) UPDATE resources r SET body=r.body||CASE recovered.state WHEN 'QUEUED' THEN jsonb_build_object('status','QUEUED','progress',0,'error',NULL) ELSE jsonb_build_object('status','FAILED','progress',NULL,'error',jsonb_build_object('code','PROVIDER_RESULT_UNKNOWN','message','공급자 호출 이후 작업이 중단되었습니다. 사용량 확인 전 재전송하지 않습니다.','retryable',false)) END,updated_at=now(),revision=revision+1 FROM recovered WHERE r.id=recovered.operation_id AND r.kind='operations'`)
	return e
}
