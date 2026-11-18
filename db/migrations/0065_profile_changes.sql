-- A profile change a Bot run applied at once keeps the values it replaced, so 되돌리기 still works
-- after the chat is reopened and on another device. id is the run's Idempotency-Key.
-- Revert: DROP TABLE profile_changes;

CREATE TABLE IF NOT EXISTS profile_changes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  before jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  PRIMARY KEY (user_id, id)
);
