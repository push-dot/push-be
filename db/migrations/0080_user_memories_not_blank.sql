-- A memory must say something: the app and the remember tool already drop whitespace-only text, and the table now
-- refuses it too, so no other writer can store an empty line that every personal turn would read.
-- Revert: ALTER TABLE user_memories DROP CONSTRAINT user_memories_text_not_blank_chk;

DELETE FROM user_memories WHERE text !~ '[^[:space:]\u3000]';

ALTER TABLE user_memories ADD CONSTRAINT user_memories_text_not_blank_chk CHECK (text ~ '[^[:space:]\u3000]');
