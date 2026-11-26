-- The plan credits a Google Play replacement chain (linkedPurchaseToken) has granted so far, on its newest row, so a plan
-- change grants only what it adds above that. NULL: the row's own plan amount (rows from before this column).
-- Revert: ALTER TABLE iap_subscriptions DROP COLUMN credit_level_micro;
ALTER TABLE iap_subscriptions ADD COLUMN credit_level_micro bigint;
