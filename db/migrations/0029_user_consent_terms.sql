ALTER TABLE user_consents
    ADD COLUMN terms_version text,
    ADD COLUMN age14_at timestamptz,
    ADD COLUMN service_terms_at timestamptz,
    ADD COLUMN privacy_at timestamptz,
    ADD COLUMN marketing boolean NOT NULL DEFAULT false,
    ADD COLUMN marketing_at timestamptz;

ALTER TABLE user_consents
    ADD CONSTRAINT user_consents_terms_chk CHECK (
        (terms_version IS NULL AND age14_at IS NULL AND service_terms_at IS NULL AND privacy_at IS NULL)
        OR (terms_version IS NOT NULL AND age14_at IS NOT NULL AND service_terms_at IS NOT NULL AND privacy_at IS NOT NULL)
    );
