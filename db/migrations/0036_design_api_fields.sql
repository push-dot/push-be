ALTER TABLE applications ADD COLUMN stage_entered_at jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE applications SET stage_entered_at = jsonb_build_object(stage, created_at) WHERE stage_entered_at = '{}'::jsonb;

ALTER TABLE calendar_events ADD COLUMN location text;
ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_location_chk CHECK (location IS NULL OR char_length(location) <= 200);

ALTER TABLE sources ADD COLUMN doc_kind text;
ALTER TABLE sources ADD CONSTRAINT sources_doc_kind_chk CHECK (doc_kind IS NULL OR char_length(doc_kind) <= 40);
