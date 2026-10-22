# Queue interface changes

The plan's table name `jobs` is already the saved-job table from `0001_init.sql`. The queue table is `ai_jobs`. Views, FKs, and enqueue SQL use that name. `chat_jobs` stays the compatibility view.

`GET /api/v1/jobs/{id}` is a saved job. Queue status is `GET /api/v1/ai/jobs/{id}` with the same body `{data:{id,type,status,progress?,result?,error?,createdAt,updatedAt}}`.
