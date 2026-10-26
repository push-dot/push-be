# Audit notes: ai-api (cross-area)

Fixes these need are outside `services/ai/src/app/{api,main,config,db,pgproto,ratelimit,...}`.

| File:line | Problem | Proposed fix |
|---|---|---|
| `services/ai/src/app/domain/services/auth.py:197` | `token == self.dev_token` is a non-constant-time compare. | `hmac.compare_digest(token.encode(), self.dev_token.encode())`. |
| `infra/vps/env.example:7`, VPS `DATABASE_URL` | asyncpg (and libpq) treat `sslmode=require` as "encrypt, don't verify the certificate", so a network attacker between the VPS and Neon can impersonate the database. | Set `sslmode=verify-full` in the VPS `DATABASE_URL`. Neon certificates are publicly trusted, and the image has CA certificates (Playwright `--with-deps`). |
| `services/gateway/src/http.ts:74` (`requestIdOf`) | Passes through any client `x-request-id` up to 128 chars. The AI service now replaces ids outside `[A-Za-z0-9._:-]{1,128}`, so gateway and AI logs can show different ids for one request. | Apply the same charset check in the gateway. |
| `README.md:205` | Says "set `DEV_AUTH_TOKEN` empty in production". The AI service now defaults `APP_ENV` to `production`. | Add: local dev must set `APP_ENV=development` for the dev token (docker-compose already does). |
| `services/gateway/src/routes/owner.ts:13` | Unknown paths fall through to `python`. Python has no route for `/api/v1/auth/me`, but owner.ts sends it there explicitly (line 34), so it is a 404 or 401. | Confirm the gateway answers `/auth/me` itself, or route it to core. |

Not changed on purpose:
- `pgproto._ssl_context`: `sslmode=require` still skips verification (libpq semantics). Only `scripts/migrate.py` uses the TCP path. Production Workers use `wss://`, which verifies.
