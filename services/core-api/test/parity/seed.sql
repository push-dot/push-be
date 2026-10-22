-- Parity seed shared by services/ai/scripts/record_parity.py and test/parity/harness.ts.
-- Clock for both sides: 2026-10-22T12:00:00Z. Token: "parity-token" for ME.
DO $$
DECLARE names text;
BEGIN
    SELECT string_agg(format('%I', tablename), ', ') INTO names
    FROM pg_tables WHERE schemaname = 'public';
    EXECUTE 'TRUNCATE ' || names || ' CASCADE';
END $$;

INSERT INTO users (id, provider, provider_subject, display_name, plan, created_at) VALUES
    ('11111111-1111-4111-8111-111111111111', 'email', 'me@parity.test', 'Me', 'PRO', '2026-01-01T00:00:00Z'),
    ('22222222-2222-4222-8222-222222222222', 'email', 'other@parity.test', 'Other', 'FREE', '2026-01-01T00:00:00Z');

INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES
    ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'parity-refresh', '2099-01-01T00:00:00Z');

INSERT INTO access_tokens (id, user_id, token_hash, refresh_token_id, expires_at) VALUES
    ('a0000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
     encode(sha256('parity-token'::bytea), 'hex'), 'a0000000-0000-4000-8000-000000000001', '2099-01-01T00:00:00Z');

INSERT INTO jobs (id, user_id, company, title, source_kind, source_text, created_at, updated_at) VALUES
    ('b0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Acme', 'Backend Engineer', 'TEXT', 'Go and Postgres', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
    ('b0000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'Other Co', 'Designer', 'TEXT', 'Figma', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');

INSERT INTO applications (id, user_id, revision, job_id, company, title, stage, notes, applied_at, next_action_at, imported, created_at, updated_at) VALUES
    ('c0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 3, 'b0000000-0000-4000-8000-000000000001', 'Acme', 'Backend Engineer', 'PREPARING', 'first', NULL, '2026-10-30T09:00:00Z', false, '2026-10-02T00:00:00Z', '2026-10-05T00:00:00.123456Z'),
    ('c0000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 1, 'b0000000-0000-4000-8000-000000000001', 'Acme', 'Platform Engineer', 'APPLIED', '', '2026-10-03T00:00:00Z', NULL, false, '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z'),
    ('c0000000-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', 1, 'b0000000-0000-4000-8000-000000000002', 'Other Co', 'Designer', 'DISCOVERED', '', NULL, NULL, false, '2026-10-04T00:00:00Z', '2026-10-04T00:00:00Z'),
    ('c0000000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', 1, 'b0000000-0000-4000-8000-000000000001', 'Beta', 'Rejected Role', 'REJECTED', '', NULL, NULL, true, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');

INSERT INTO application_events (id, user_id, application_id, type, payload, created_at) VALUES
    ('c1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'c0000000-0000-4000-8000-000000000001', 'STAGE_CHANGED', '{"from": "DISCOVERED", "to": "PREPARING"}', '2026-10-04T00:00:00Z'),
    ('c1000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'c0000000-0000-4000-8000-000000000001', 'IMPORTED', '{"stage": "PREPARING", "appliedAt": null}', '2026-10-03T00:00:00Z');

INSERT INTO gap_analyses (id, user_id, application_id, job_id, job_revision, fit_score, method, created_at) VALUES
    ('c2000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 1, 64, 'RULE_BASED', '2026-10-04T00:00:00Z'),
    ('c2000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 1, 72, 'RULE_BASED', '2026-10-05T00:00:00Z');

INSERT INTO documents (id, user_id, revision, application_id, title, kind, template, status, created_at, updated_at) VALUES
    ('d0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 2, 'c0000000-0000-4000-8000-000000000001', 'Resume', 'RESUME', 'SIMPLE', 'FINALIZED', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z'),
    ('d0000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 1, 'c0000000-0000-4000-8000-000000000002', 'Other app resume', 'RESUME', 'SIMPLE', 'DRAFT', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z');

INSERT INTO document_versions (id, user_id, document_id, application_id, number, content, created_at) VALUES
    ('d1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 1, '{"type": "doc", "content": []}', '2026-10-02T00:00:00Z'),
    ('d1000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 2, '{"type": "doc", "content": []}', '2026-10-02T00:00:01Z'),
    ('d1000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'd0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', 1, '{"type": "doc", "content": []}', '2026-10-02T00:00:00Z');

UPDATE documents SET latest_version_id = 'd1000000-0000-4000-8000-000000000002', finalized_version_id = 'd1000000-0000-4000-8000-000000000001'
    WHERE id = 'd0000000-0000-4000-8000-000000000001';
UPDATE documents SET latest_version_id = 'd1000000-0000-4000-8000-000000000003'
    WHERE id = 'd0000000-0000-4000-8000-000000000002';

INSERT INTO submission_drafts (id, user_id, application_id, application_revision, mode, adapter, document_version_ids, confirmed_submitted, payload_hash, created_at) VALUES
    ('e0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'c0000000-0000-4000-8000-000000000001', 3, 'MANUAL_RECORD', NULL, '["d1000000-0000-4000-8000-000000000001"]', true, 'hash-draft-1', '2026-10-06T00:00:00Z'),
    ('e0000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'c0000000-0000-4000-8000-000000000001', 3, 'MANUAL_RECORD', NULL, '["d1000000-0000-4000-8000-000000000001"]', false, 'hash-draft-2', '2026-10-06T00:00:00Z');

INSERT INTO approvals (id, user_id, revision, kind, application_id, target_id, payload_hash, status, expires_at, decided_at, created_at, updated_at) VALUES
    ('e1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 2, 'APPLICATION_SUBMIT', 'c0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'hash-draft-1', 'APPROVED', '2099-01-01T00:00:00Z', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z'),
    ('e1000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 1, 'APPLICATION_SUBMIT', 'c0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002', 'hash-draft-2', 'PENDING', '2099-01-01T00:00:00Z', NULL, '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z');

INSERT INTO submissions (id, user_id, application_id, mode, adapter, status, document_version_ids, approval_id, created_at, updated_at) VALUES
    ('e2000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'c0000000-0000-4000-8000-000000000002', 'MANUAL_RECORD', NULL, 'SUCCEEDED', '[]', NULL, '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z');

INSERT INTO career_evidence (id, user_id, kind, title, source_text, created_at, updated_at) VALUES
    ('f0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'PROJECT', 'Payments', 'Built payments', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');

-- sources group
INSERT INTO sources (id, user_id, file_name, mime_type, size, sha256, path, status, created_at, content, page_count, origin) VALUES
    ('f1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'notes.txt', 'text/plain', 12, 'sha-notes', 'db://sources/f1000000-0000-4000-8000-000000000001', 'STORED', '2026-10-03T00:00:00.5Z', convert_to('hello 이력서', 'UTF8'), NULL, 'UPLOAD'),
    ('f1000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'resume.pdf', 'application/pdf', 9, 'sha-pdf', 'db://sources/f1000000-0000-4000-8000-000000000002', 'STORED', '2026-10-03T00:00:00Z', decode('255044462d312e340a', 'hex'), 2, 'UPLOAD'),
    ('f1000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'old.md', 'text/markdown', 3, 'sha-md', 'db://sources/f1000000-0000-4000-8000-000000000003', 'STORED', '2026-09-30T00:00:00Z', convert_to('# x', 'UTF8'), NULL, 'AI'),
    ('f1000000-0000-4000-8000-000000000004', '22222222-2222-4222-8222-222222222222', 'other.txt', 'text/plain', 5, 'sha-other', 'db://sources/f1000000-0000-4000-8000-000000000004', 'STORED', '2026-10-03T00:00:00Z', convert_to('other', 'UTF8'), NULL, 'UPLOAD');

INSERT INTO career_evidence (id, user_id, revision, kind, title, source_text, source_url, skills, verification_status, provenance, supersedes_id, archived, created_at, updated_at) VALUES
    ('f0000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 2, 'RESUME', 'From resume', 'Payments lead', 'https://example.com/cv', '["Go", "SQL"]', 'USER_PROVIDED', '{"sourceId": "f1000000-0000-4000-8000-000000000002", "contentHash": "abc", "sourceLocation": {"start": 0, "end": 5, "unit": "CODE_POINT"}}', NULL, false, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z'),
    ('f0000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 1, 'SKILL', 'Old skill', 'Perl', NULL, '[]', 'USER_PROVIDED', '{}', NULL, true, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
    ('f0000000-0000-4000-8000-000000000004', '22222222-2222-4222-8222-222222222222', 1, 'PROJECT', 'Not mine', 'Hidden', NULL, '[]', 'USER_PROVIDED', '{}', NULL, false, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');

INSERT INTO upload_images (key, user_id, mime_type, content, created_at) VALUES
    ('0123456789abcdef0123456789abcdef.png', '11111111-1111-4111-8111-111111111111', 'image/png', decode('89504e470d0a1a0a0000000d49484452', 'hex'), '2026-10-01T00:00:00Z');
