CREATE TABLE experiments (
    key text PRIMARY KEY,
    variants jsonb NOT NULL,
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE experiment_assignments (
    experiment_key text NOT NULL REFERENCES experiments(key),
    user_id uuid NOT NULL REFERENCES users(id),
    variant text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (experiment_key, user_id)
);

CREATE TABLE experiment_events (
    id uuid PRIMARY KEY,
    experiment_key text NOT NULL REFERENCES experiments(key),
    user_id uuid NOT NULL REFERENCES users(id),
    variant text NOT NULL,
    event text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_experiment_events ON experiment_events (experiment_key, variant, event);
