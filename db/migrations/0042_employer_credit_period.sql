ALTER TABLE companies ADD COLUMN credit_period_start timestamptz;

CREATE TABLE billing_alerts (
    id uuid PRIMARY KEY,
    company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
    kind text NOT NULL,
    reference_id text NOT NULL,
    detail text,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    UNIQUE (kind, reference_id)
);
CREATE INDEX idx_billing_alerts_open ON billing_alerts (created_at) WHERE resolved_at IS NULL;

-- The 이전 구독 해지 실패 note moves from the customer ledger to the operator table.
INSERT INTO billing_alerts (id, company_id, kind, reference_id, detail, created_at)
SELECT gen_random_uuid(), company_id, 'CANCEL_FAILED', substr(reference_id, length('cancel_failed:') + 1), description, created_at
FROM billing_ledger
WHERE company_id IS NOT NULL AND reference_id LIKE 'cancel_failed:%' AND amount_micro_credits = 0
ON CONFLICT (kind, reference_id) DO NOTHING;
DELETE FROM billing_ledger WHERE company_id IS NOT NULL AND reference_id LIKE 'cancel_failed:%' AND amount_micro_credits = 0;
