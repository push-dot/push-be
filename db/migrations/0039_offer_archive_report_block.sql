CREATE TABLE offer_archives (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    offer_id uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    archived_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, offer_id)
);

CREATE TABLE offer_reports (
    id uuid PRIMARY KEY,
    reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    offer_id uuid REFERENCES offers(id) ON DELETE SET NULL,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_offer_reports_reported ON offer_reports (reported_user_id, created_at DESC);

CREATE TABLE user_blocks (
    blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id),
    CONSTRAINT user_blocks_not_self CHECK (blocker_id <> blocked_id)
);
CREATE INDEX idx_user_blocks_list ON user_blocks (blocker_id, created_at DESC, blocked_id DESC);
