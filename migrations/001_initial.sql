CREATE TABLE IF NOT EXISTS resources (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, kind text NOT NULL,
 application_id uuid, body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resources_owner_kind ON resources(owner_id,kind,created_at);
CREATE INDEX IF NOT EXISTS resources_application ON resources(owner_id,application_id);
CREATE TABLE IF NOT EXISTS identities (provider text NOT NULL, subject text NOT NULL, user_id uuid NOT NULL, PRIMARY KEY(provider,subject));
CREATE TABLE IF NOT EXISTS sessions (access_hash text PRIMARY KEY, refresh_hash text UNIQUE NOT NULL, user_id uuid NOT NULL, access_expires timestamptz NOT NULL, refresh_expires timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_states (state_hash text PRIMARY KEY, provider text NOT NULL, challenge text NOT NULL, redirect_uri text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS auth_codes (code_hash text PRIMARY KEY, user_id uuid NOT NULL, challenge text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS ai_keys (owner_id uuid NOT NULL, provider text NOT NULL, ciphertext bytea NOT NULL, last_four text NOT NULL, PRIMARY KEY(owner_id,provider));
CREATE TABLE IF NOT EXISTS billing (owner_id uuid PRIMARY KEY, customer_id text UNIQUE, active boolean NOT NULL DEFAULT false, credits bigint NOT NULL DEFAULT 0 CHECK (credits >= 0));
CREATE TABLE IF NOT EXISTS billing_events (id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS google_connections (owner_id uuid PRIMARY KEY, ciphertext bytea NOT NULL, gmail_history text NOT NULL DEFAULT '', calendar_sync text NOT NULL DEFAULT '');

ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS verifier text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS idempotency(owner_id uuid NOT NULL,method text NOT NULL,path text NOT NULL,key uuid NOT NULL,body_hash text NOT NULL,status integer NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,method,path,key));
CREATE TABLE IF NOT EXISTS changes(sequence bigserial PRIMARY KEY,owner_id uuid NOT NULL,resource_type text NOT NULL,resource_id uuid NOT NULL,revision integer NOT NULL,deleted boolean NOT NULL DEFAULT false,data jsonb,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sync_mutations(owner_id uuid NOT NULL,client_id uuid NOT NULL,mutation_id uuid NOT NULL,digest text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(owner_id,client_id,mutation_id));
CREATE OR REPLACE FUNCTION track_resource_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_value resources; deleted_value boolean; type_value text;
BEGIN
 IF TG_OP='DELETE' THEN row_value:=OLD;deleted_value:=true;ELSE row_value:=NEW;deleted_value:=false;END IF;
 type_value:=CASE row_value.kind WHEN 'drafts' THEN 'DOCUMENT_DRAFT' WHEN 'applications' THEN 'APPLICATION' WHEN 'calendar-events' THEN 'CALENDAR_EVENT' WHEN 'documents' THEN 'DOCUMENT' ELSE NULL END;
 IF type_value IS NOT NULL THEN
 INSERT INTO changes(owner_id,resource_type,resource_id,revision,deleted,data) VALUES(row_value.owner_id,type_value,row_value.id,row_value.revision,deleted_value,CASE WHEN deleted_value THEN NULL ELSE row_value.body||jsonb_build_object('id',row_value.id,'revision',row_value.revision,'createdAt',row_value.created_at,'updatedAt',row_value.updated_at) END);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS resources_changes ON resources;
CREATE TRIGGER resources_changes AFTER INSERT OR UPDATE OR DELETE ON resources FOR EACH ROW EXECUTE FUNCTION track_resource_change();
CREATE TABLE IF NOT EXISTS source_files(id uuid PRIMARY KEY,owner_id uuid NOT NULL,content bytea NOT NULL);
ALTER TABLE billing ADD COLUMN IF NOT EXISTS last_event_time bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS stripe_refunds(charge_id text PRIMARY KEY,amount bigint NOT NULL);
ALTER TABLE billing ADD COLUMN IF NOT EXISTS reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0);
CREATE TABLE IF NOT EXISTS work_queue(operation_id uuid PRIMARY KEY,owner_id uuid NOT NULL,kind text NOT NULL,application_id uuid NOT NULL,input jsonb NOT NULL,state text NOT NULL DEFAULT 'QUEUED',started_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE google_connections ADD COLUMN IF NOT EXISTS scopes jsonb NOT NULL DEFAULT '[]';
ALTER TABLE google_connections ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS owner_id uuid;
CREATE TABLE IF NOT EXISTS integration_codes(code_hash text PRIMARY KEY,owner_id uuid NOT NULL,challenge text NOT NULL,ciphertext bytea NOT NULL,scopes jsonb NOT NULL,expires_at timestamptz NOT NULL);
ALTER TABLE ai_keys ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS user_profiles(id uuid PRIMARY KEY,display_name text NOT NULL DEFAULT '',locale text NOT NULL DEFAULT 'ko',created_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION record_timeline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.application_id IS NOT NULL AND NEW.kind IN ('applications','documents','approvals','interviews','offers','submissions') THEN
 INSERT INTO resources(id,owner_id,kind,application_id,body) VALUES(gen_random_uuid(),NEW.owner_id,'timeline',NEW.application_id,jsonb_build_object('applicationId',NEW.application_id,'resourceType',NEW.kind,'resourceId',NEW.id,'eventType',TG_OP,'resourceRevision',NEW.revision,'title',COALESCE(NEW.body->>'title',NEW.body->>'kind',NEW.kind),'stage',NEW.body->>'stage'));
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS resources_timeline ON resources;
CREATE TRIGGER resources_timeline AFTER INSERT OR UPDATE ON resources FOR EACH ROW EXECUTE FUNCTION record_timeline();
CREATE TABLE IF NOT EXISTS operation_events(operation_id uuid NOT NULL,owner_id uuid NOT NULL,sequence bigint NOT NULL,event_type text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(operation_id,sequence));
CREATE INDEX IF NOT EXISTS operation_events_owner ON operation_events(owner_id,operation_id,sequence);
CREATE OR REPLACE FUNCTION record_operation_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_name text;event_payload jsonb;next_sequence bigint;
BEGIN
 IF NEW.kind<>'operations' THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' AND NEW.body->'status' IS NOT DISTINCT FROM OLD.body->'status' AND NEW.body->'progress' IS NOT DISTINCT FROM OLD.body->'progress' AND NEW.body->'result' IS NOT DISTINCT FROM OLD.body->'result' AND NEW.body->'error' IS NOT DISTINCT FROM OLD.body->'error' THEN RETURN NEW;END IF;
 event_name:=CASE NEW.body->>'status' WHEN 'SUCCEEDED' THEN 'result' WHEN 'FAILED' THEN 'error' ELSE 'progress' END;
 event_payload:=CASE event_name WHEN 'result' THEN NEW.body->'result' WHEN 'error' THEN NEW.body->'error' ELSE jsonb_build_object('status',NEW.body->'status','progress',NEW.body->'progress','step',NEW.body->'type') END;
 SELECT COALESCE(MAX(sequence),0)+1 INTO next_sequence FROM operation_events WHERE operation_id=NEW.id;
 INSERT INTO operation_events(operation_id,owner_id,sequence,event_type,payload) VALUES(NEW.id,NEW.owner_id,next_sequence,event_name,event_payload);
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS resources_operation_events ON resources;
CREATE TRIGGER resources_operation_events AFTER INSERT OR UPDATE ON resources FOR EACH ROW EXECUTE FUNCTION record_operation_event();
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz;
ALTER TABLE work_queue ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE source_files ADD COLUMN IF NOT EXISTS extracted_text text;
CREATE TABLE IF NOT EXISTS github_connections(owner_id uuid PRIMARY KEY,ciphertext bytea NOT NULL);

ALTER TABLE billing ADD COLUMN IF NOT EXISTS period_ends_at timestamptz;

ALTER TABLE billing DROP CONSTRAINT IF EXISTS billing_credits_check;
