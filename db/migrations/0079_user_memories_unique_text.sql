-- One row per fact per user: the AI's remember tool upserts on (user_id, text), so saying the same thing again
-- moves it to the top instead of adding a copy, also when two turns remember it at once.
-- Revert: DROP INDEX user_memories_user_text_key;

DELETE FROM user_memories a USING user_memories b
WHERE a.user_id = b.user_id AND a.text = b.text AND (a.updated_at, a.id) < (b.updated_at, b.id);

CREATE UNIQUE INDEX user_memories_user_text_key ON user_memories (user_id, text);
