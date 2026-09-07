package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"github.com/labstack/echo/v4"
	"strconv"
)

type SyncMutation struct {
	ID         string         `json:"mutationId"`
	Type       string         `json:"resourceType"`
	ResourceID string         `json:"resourceId"`
	Expected   int            `json:"expectedRevision"`
	Action     string         `json:"action"`
	Payload    map[string]any `json:"payload"`
}

func (s *Server) syncRoutes(g *echo.Group) {
	g.GET("/sync/changes", func(c echo.Context) error {
		cursor := int64(0)
		if raw := c.QueryParam("cursor"); raw != "" {
			b, e := base64.RawURLEncoding.DecodeString(raw)
			if e != nil {
				return invalid("cursor 오류")
			}
			n, e := strconv.ParseInt(string(b), 10, 64)
			if e != nil || n < 0 {
				return invalid("cursor 오류")
			}
			cursor = n
		}
		limit := 50
		if v := c.QueryParam("limit"); v != "" {
			n, e := strconv.Atoi(v)
			if e != nil || n < 1 || n > 100 {
				return invalid("limit 오류")
			}
			limit = n
		}
		rows, e := s.q(c).Query(c.Request().Context(), "SELECT sequence,resource_type,resource_id,revision,deleted,data FROM changes WHERE owner_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3", owner(c), cursor, limit+1)
		if e != nil {
			return e
		}
		defer rows.Close()
		out := []any{}
		next := cursor
		more := false
		for rows.Next() {
			var seq int64
			var kind, id string
			var rev int
			var deleted bool
			var raw []byte
			if e = rows.Scan(&seq, &kind, &id, &rev, &deleted, &raw); e != nil {
				return e
			}
			if len(out) == limit {
				more = true
				break
			}
			var payload any
			if raw != nil {
				if e = json.Unmarshal(raw, &payload); e != nil {
					return e
				}
			}
			out = append(out, map[string]any{"sequence": seq, "resourceType": kind, "resourceId": id, "revision": rev, "deleted": deleted, "data": payload})
			next = seq
		}
		if e = rows.Err(); e != nil {
			return e
		}
		return ok(c, 200, map[string]any{"changes": out, "nextCursor": base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(next, 10))), "hasMore": more})
	})
	g.POST("/sync/mutations", func(c echo.Context) error {
		var in struct {
			ClientID  string         `json:"clientId"`
			Mutations []SyncMutation `json:"mutations"`
		}
		if e := decode(c, &in); e != nil {
			return e
		}
		if !validID(in.ClientID) || len(in.Mutations) > 50 || len(in.Mutations) == 0 {
			return invalid("clientId와 1~50개 mutation이 필요합니다")
		}
		results := []any{}
		outer := c.Get("tx").(pgx.Tx)
		for _, m := range in.Mutations {
			if !validID(m.ID) || !validID(m.ResourceID) {
				return invalid("mutation UUID 오류")
			}
			digest := hashJSON(m)
			var priorDigest string
			var prior []byte
			e := outer.QueryRow(c.Request().Context(), "SELECT digest,result FROM sync_mutations WHERE owner_id=$1 AND client_id=$2 AND mutation_id=$3", owner(c), in.ClientID, m.ID).Scan(&priorDigest, &prior)
			if e == nil {
				if priorDigest != digest {
					return fail(409, "IDEMPOTENCY_CONFLICT", "mutation 내용이 다릅니다")
				}
				var old any
				json.Unmarshal(prior, &old)
				results = append(results, old)
				continue
			}
			if e != pgx.ErrNoRows {
				return e
			}
			tx, e := outer.Begin(c.Request().Context())
			if e != nil {
				return e
			}
			c.Set("tx", tx)
			resource, applyErr := s.applyMutation(c, m)
			c.Set("tx", outer)
			status := "APPLIED"
			var detail any
			if applyErr != nil {
				_ = tx.Rollback(context.Background())
				status = "REJECTED"
				code, message := "VALIDATION_ERROR", "변경을 적용할 수 없습니다"
				if ae, ok := applyErr.(*apiError); ok {
					code, message = ae.Code, ae.Message
					if ae.Code == "REVISION_CONFLICT" {
						status = "CONFLICT"
					}
				}
				detail = map[string]any{"code": code, "message": message}
				resource = nil
			} else {
				if e = tx.Commit(c.Request().Context()); e != nil {
					return e
				}
			}
			result := map[string]any{"mutationId": m.ID, "status": status, "resource": resource, "error": detail}
			b, _ := json.Marshal(result)
			if _, e = outer.Exec(c.Request().Context(), "INSERT INTO sync_mutations(owner_id,client_id,mutation_id,digest,result) VALUES($1,$2,$3,$4,$5)", owner(c), in.ClientID, m.ID, digest, b); e != nil {
				return e
			}
			results = append(results, result)
		}
		return ok(c, 200, map[string]any{"results": results})
	})
}
func (s *Server) applyMutation(c echo.Context, m SyncMutation) (map[string]any, error) {
	if m.Type == "APPLICATION" && m.Action == "UPDATE_NOTES" {
		var in struct {
			Notes string `json:"notes"`
		}
		if e := decodeMap(m.Payload, &in); e != nil {
			return nil, e
		}
		if len(in.Notes) > 100000 {
			return nil, invalid("notes 길이 초과")
		}
		v, e := s.get(c, "applications", m.ResourceID)
		if e != nil {
			return nil, e
		}
		if e = s.checkRevision(c, v, m.Expected); e != nil {
			return nil, e
		}
		v["notes"] = in.Notes
		return s.update(c, "applications", v, m.Expected)
	}
	if m.Type == "CALENDAR_EVENT" && m.Action == "UPDATE_LOCAL" {
		var in EventPatch
		if _, bad := m.Payload["expectedRevision"]; bad {
			return nil, invalid("payload에 revision을 넣지 마세요")
		}
		if e := decodeMap(m.Payload, &in); e != nil {
			return nil, e
		}
		v, e := s.get(c, "calendar-events", m.ResourceID)
		if e != nil {
			return nil, e
		}
		if e = s.checkRevision(c, v, m.Expected); e != nil {
			return nil, e
		}
		if e = applyEventPatch(v, in); e != nil {
			return nil, e
		}
		return s.update(c, "calendar-events", v, m.Expected)
	}
	if m.Type == "DOCUMENT_DRAFT" && oneOf(m.Action, "CREATE", "UPDATE") {
		var in struct {
			DocumentID string       `json:"documentId"`
			Base       int          `json:"baseDocumentRevision"`
			Content    TipTapNode   `json:"content"`
			Blocks     []BlockInput `json:"blocks"`
		}
		if e := decodeMap(m.Payload, &in); e != nil {
			return nil, e
		}
		if in.Base < 1 {
			return nil, invalid("baseDocumentRevision 오류")
		}
		var draft, doc map[string]any
		var e error
		if m.Action == "CREATE" {
			if m.Expected != 0 {
				return nil, invalid("CREATE revision은 0입니다")
			}
			doc, e = s.get(c, "documents", in.DocumentID)
		} else {
			if in.DocumentID != "" {
				return nil, invalid("UPDATE는 documentId를 변경할 수 없습니다")
			}
			draft, e = s.get(c, "drafts", m.ResourceID)
			if e != nil {
				return nil, e
			}
			if e = s.checkRevision(c, draft, m.Expected); e != nil {
				return nil, e
			}
			doc, e = s.get(c, "documents", str(draft, "documentId"))
		}
		if e != nil {
			return nil, e
		}
		if _, e = s.validatedBlocks(c, str(doc, "applicationId"), in.Content, in.Blocks); e != nil {
			return nil, e
		}
		if m.Action == "CREATE" {
			return s.createWithID(c, "drafts", str(doc, "applicationId"), m.ResourceID, map[string]any{"documentId": doc["id"], "applicationId": doc["applicationId"], "baseDocumentRevision": in.Base, "content": in.Content, "blocks": in.Blocks})
		}
		draft["baseDocumentRevision"] = in.Base
		draft["content"] = in.Content
		draft["blocks"] = in.Blocks
		return s.update(c, "drafts", draft, m.Expected)
	}
	return nil, invalid("허용하지 않는 오프라인 작업입니다")
}
