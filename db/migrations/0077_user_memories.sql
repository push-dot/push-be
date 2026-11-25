-- What a user's bots remember about them across bots and threads (선호, 결정, 제약). The AI service writes rows
-- with its remember tool and reads them into every personal turn; the app lists, edits and deletes them
-- (services/core-api/src/routes/memories.ts). Deleting the user deletes them.
-- Additive: code from before this file keeps working.
-- Revert: DROP TABLE user_memories;

CREATE TABLE user_memories (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text text NOT NULL CONSTRAINT user_memories_text_chk CHECK (char_length(text) BETWEEN 1 AND 300),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_memories_user_idx ON user_memories (user_id, updated_at DESC);
