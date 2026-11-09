-- The last Stripe subscription that ended for good (deleted, canceled, incomplete_expired).
-- A customer.subscription.updated read from Stripe before the delete and written after it skips this id, so it never brings the plan back.
ALTER TABLE companies ADD COLUMN stripe_ended_subscription_id text;
ALTER TABLE users ADD COLUMN stripe_ended_subscription_id text;
