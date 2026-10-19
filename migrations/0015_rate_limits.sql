CREATE TABLE rate_limits (
    bucket text PRIMARY KEY,
    hits integer NOT NULL,
    expires_at timestamptz NOT NULL
);

CREATE INDEX rate_limits_expires_at_idx ON rate_limits (expires_at);
