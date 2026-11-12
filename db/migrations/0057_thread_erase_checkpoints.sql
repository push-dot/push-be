-- Deleting a thread also erases the model's memory of it, and a bot's finished turns are kept small.
-- The AI service's LangGraph checkpointer stores each thread's state (the whole conversation text)
-- in checkpoints, checkpoint_blobs and checkpoint_writes under thread_id = the conversation id.
-- Those tables have no key to conversations, so every delete (bot delete, clear chat, conversation
-- delete, account and company purge) left the text there. A trigger on conversations now erases a
-- deleted thread's rows in the transaction of the delete, whatever statement or cascade deleted it.
-- The checkpointer creates its tables on first start (AsyncPostgresSaver.setup), so they may not
-- exist when this file runs. Each function checks for checkpoint_migrations, the table setup()
-- writes first, and does nothing without it. With it, a missing table is an error: a delete fails
-- instead of leaving a thread's text behind when LangGraph renames a table.
-- Additive: code from before this file keeps working.
-- Revert: DROP TRIGGER conversations_erase_checkpoints ON conversations;
--         DROP FUNCTION conversations_erase_checkpoints(), sweep_orphan_checkpoints(integer), erase_checkpoints(text[]);
--         DROP INDEX ai_jobs_finished_uncompacted_idx;

-- The only list of the tables that hold a thread. It matches AsyncPostgresSaver.adelete_thread,
-- and services/ai/tests/test_checkpoint_erase_pg.py fails when the two differ.
CREATE FUNCTION erase_checkpoints(threads text[]) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF to_regclass('checkpoint_migrations') IS NULL OR cardinality(threads) = 0 THEN
        RETURN;
    END IF;
    DELETE FROM checkpoint_writes WHERE thread_id = ANY(threads);
    DELETE FROM checkpoint_blobs WHERE thread_id = ANY(threads);
    DELETE FROM checkpoints WHERE thread_id = ANY(threads);
END;
$$;

CREATE FUNCTION conversations_erase_checkpoints() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM erase_checkpoints(ARRAY(SELECT id::text FROM gone));
    RETURN NULL;
END;
$$;

CREATE TRIGGER conversations_erase_checkpoints
AFTER DELETE ON conversations
REFERENCING OLD TABLE AS gone
FOR EACH STATEMENT EXECUTE FUNCTION conversations_erase_checkpoints();

-- A run that is still going when its thread is deleted can write checkpoints after the delete.
-- The dispatcher calls this once per maintenance pass: up to `batch` threads that no conversation
-- has. It reads every thread id of the three tables, through LangGraph's thread_id indexes.
CREATE FUNCTION sweep_orphan_checkpoints(batch integer) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
    orphans text[];
BEGIN
    IF to_regclass('checkpoint_migrations') IS NULL THEN
        RETURN 0;
    END IF;
    SELECT ARRAY(
        SELECT t.thread_id
        FROM (SELECT thread_id FROM checkpoints
              UNION SELECT thread_id FROM checkpoint_blobs
              UNION SELECT thread_id FROM checkpoint_writes) t
        WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id::text = t.thread_id)
        LIMIT batch
    ) INTO orphans;
    PERFORM erase_checkpoints(orphans);
    RETURN cardinality(orphans);
END;
$$;

-- Finished jobs that are not a compacted bot turn. Only bot turns are compacted and they are kept for
-- good, so they leave this index, and the 30-day purge and the compaction pass do not read them again.
-- Apply off-peak: run_migrations wraps each file in one transaction (no CONCURRENTLY).
CREATE INDEX ai_jobs_finished_uncompacted_idx ON ai_jobs (updated_at)
    WHERE status IN ('DONE', 'FAILED', 'DEAD', 'CANCELLED') AND NOT (checkpoint ? 'compacted');
