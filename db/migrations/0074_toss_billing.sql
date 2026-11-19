CREATE TABLE toss_billing (
    company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    customer_key text NOT NULL UNIQUE,
    billing_key_enc text,
    plan text,
    period_start timestamptz,
    period_end timestamptz,
    next_charge_at timestamptz,
    canceled_at timestamptz,
    failures integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT toss_billing_plan_chk CHECK (plan IS NULL OR plan IN ('BASIC', 'PRO', 'ULTRA'))
);
CREATE INDEX toss_billing_due_idx ON toss_billing (next_charge_at) WHERE next_charge_at IS NOT NULL;

CREATE TABLE toss_orders (
    order_id uuid PRIMARY KEY,
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    kind text NOT NULL,
    plan text,
    packs integer,
    amount integer NOT NULL,
    status text NOT NULL DEFAULT 'PENDING',
    payment_key text,
    receipt_url text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT toss_orders_kind_chk CHECK (kind IN ('PLAN', 'TOPUP')),
    CONSTRAINT toss_orders_status_chk CHECK (status IN ('PENDING', 'DONE', 'FAILED'))
);
CREATE INDEX toss_orders_company_idx ON toss_orders (company_id, created_at DESC);

ALTER TABLE billing_ledger ADD COLUMN amount_krw integer;
