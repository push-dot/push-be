-- A chat job cannot reach a final status without a terminal event (done, error, cancelled).
-- A client's status line and its held-back next message both wait for that event. Seven
-- statements in two services end a job and only some wrote one: a job that died (DEAD, by the
-- worker or by the dispatcher after a lost heartbeat) wrote none, and a card answer the runtime
-- drops finished DONE with none, so the line kept counting for ever.
-- The rule sits on the status change. An emit after the change cannot work: ChatJobStore.emit
-- drops an error for a job the chat_jobs view already shows as FAILED, and DEAD reads as FAILED.
-- Additive: code from before this file keeps working. The gateway of that code still inserts its
-- own cancelled row, so a cancel has two until the gateway of this release is out, and a stream
-- ends at the first. The gateway of this release calls chat_run_resumable in its cancel.
-- Revert: DROP TRIGGER ai_jobs_end_event ON ai_jobs;
--         DROP FUNCTION ai_jobs_end_event();
--         DROP FUNCTION chat_run_resumable(uuid);

-- Whether the document flow of a thread goes on with the next message after a stop.
-- The only definition: the trigger below and the gateway's cancel response both call it.
CREATE FUNCTION chat_run_resumable(conversation uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT COALESCE((SELECT resume_state->>'status' FROM conversations WHERE id = conversation), '') = 'active'
$$;

CREATE FUNCTION ai_jobs_end_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM chat_events e WHERE e.job_id = NEW.id AND e.type IN ('done', 'error', 'cancelled')) THEN
        INSERT INTO chat_events (job_id, type, payload) VALUES (
            NEW.id,
            CASE NEW.status WHEN 'DONE' THEN 'done' WHEN 'CANCELLED' THEN 'cancelled' ELSE 'error' END,
            CASE NEW.status
                WHEN 'DONE' THEN '{}'::jsonb
                WHEN 'CANCELLED' THEN jsonb_build_object('resumable', chat_run_resumable(NEW.conversation_id))
                ELSE jsonb_build_object('error', jsonb_build_object('code', 'JOB_FAILED', 'message', 'job failed', 'details', NULL))
            END);
    END IF;
    RETURN NULL;
END;
$$;

-- The WHEN clause is the filter, so a heartbeat costs one comparison. It also fires for a cancel
-- through the chat_jobs view, whose INSTEAD OF trigger updates ai_jobs. The job types are those
-- of that view (0023).
CREATE TRIGGER ai_jobs_end_event
AFTER UPDATE ON ai_jobs
FOR EACH ROW WHEN (
    NEW.status IN ('DONE', 'FAILED', 'DEAD', 'CANCELLED') AND OLD.status IS DISTINCT FROM NEW.status
    AND NEW.type IN ('chat', 'employer_ai') AND NEW.conversation_id IS NOT NULL)
EXECUTE FUNCTION ai_jobs_end_event();
