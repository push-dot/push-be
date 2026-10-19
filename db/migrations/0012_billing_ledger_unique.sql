DELETE FROM billing_ledger a
USING billing_ledger b
WHERE a.ctid < b.ctid
  AND a.user_id = b.user_id
  AND a.type = b.type
  AND a.reference_id IS NOT DISTINCT FROM b.reference_id;

CREATE UNIQUE INDEX idx_billing_ledger_ref
    ON billing_ledger (user_id, type, reference_id);
