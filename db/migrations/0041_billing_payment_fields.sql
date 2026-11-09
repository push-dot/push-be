ALTER TABLE billing_ledger ADD COLUMN description text;
ALTER TABLE billing_ledger ADD COLUMN amount_usd_cents integer;
ALTER TABLE billing_ledger ADD COLUMN receipt_url text;
ALTER TABLE billing_ledger ADD CONSTRAINT billing_ledger_amount_usd_chk CHECK (amount_usd_cents IS NULL OR amount_usd_cents >= 0);

ALTER TABLE companies ADD COLUMN stripe_subscription_id text;
