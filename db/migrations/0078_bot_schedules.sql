-- A prompt a bot runs on its own at a saved time (매일 아침 9시에 새 공고 3개 찾아 줘). The hourly cron of core-api
-- (services/core-api/src/routes/bot-schedules.ts) sends each due row to the bot's thread as the user would.
-- hour and weekday are Korea time (UTC+9); weekday is 0 Sunday to 6 Saturday and is set exactly for WEEKLY.
-- Additive: code from before this file keeps working.
-- Revert: DROP TABLE bot_schedules;

CREATE TABLE bot_schedules (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    prompt text NOT NULL CONSTRAINT bot_schedules_prompt_chk CHECK (char_length(prompt) BETWEEN 1 AND 500),
    cadence text NOT NULL CONSTRAINT bot_schedules_cadence_chk CHECK (cadence IN ('DAILY', 'WEEKDAYS', 'WEEKLY')),
    hour smallint NOT NULL CONSTRAINT bot_schedules_hour_chk CHECK (hour BETWEEN 0 AND 23),
    weekday smallint CONSTRAINT bot_schedules_weekday_chk
        CHECK ((cadence = 'WEEKLY') = (weekday IS NOT NULL) AND (weekday IS NULL OR weekday BETWEEN 0 AND 6)),
    enabled boolean NOT NULL DEFAULT true,
    next_run_at timestamptz NOT NULL,
    last_run_at timestamptz,
    last_job_id uuid,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bot_schedules_due_idx ON bot_schedules (next_run_at) WHERE enabled;
CREATE INDEX bot_schedules_user_idx ON bot_schedules (user_id);
CREATE INDEX bot_schedules_bot_idx ON bot_schedules (bot_id);
