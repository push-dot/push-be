-- The company ledger list (GET /billing/ledger) runs in commit order, WHERE company_id = $1 AND user_id IS NULL
-- ORDER BY seq DESC, like idx_billing_ledger_user_seq for users. Additive: the code before it reads the same rows.
-- run_migrations wraps each file in a transaction, so it is not CONCURRENTLY: it blocks ledger writes while it builds.
CREATE INDEX IF NOT EXISTS idx_billing_ledger_company_seq ON billing_ledger (company_id, seq DESC)
    WHERE company_id IS NOT NULL AND user_id IS NULL;
