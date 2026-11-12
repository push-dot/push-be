-- Commit order of ledger rows. Every write holds its owner's row lock (users or companies, FOR NO KEY UPDATE), so within
-- one owner a larger seq is a later commit, while created_at is when the request started and can be earlier than a row
-- committed while it waited for the lock. The latest balance_after of a user is the row with the largest seq.
-- Existing rows are numbered in the old (created_at, id) order, so their latest row does not change.
ALTER TABLE billing_ledger ADD COLUMN seq bigint;
UPDATE billing_ledger l SET seq = o.n
FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM billing_ledger) o
WHERE l.id = o.id;
ALTER TABLE billing_ledger ALTER COLUMN seq SET NOT NULL;
ALTER TABLE billing_ledger ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY;
SELECT setval(pg_get_serial_sequence('billing_ledger', 'seq'), COALESCE((SELECT max(seq) FROM billing_ledger), 0) + 1, false);
CREATE INDEX idx_billing_ledger_user_seq ON billing_ledger (user_id, seq DESC);
