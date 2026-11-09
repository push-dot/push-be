ALTER TABLE billing_ledger ADD COLUMN description text;
ALTER TABLE billing_ledger ADD COLUMN amount_usd_cents integer;
ALTER TABLE billing_ledger ADD COLUMN receipt_url text;

ALTER TABLE companies ADD COLUMN stripe_subscription_id text;
ALTER TABLE companies ADD COLUMN stripe_subscription_created_at timestamptz;
