-- A retried fit job reuses one ai_usage id. reservation_gen bumps each time that
-- row is reserved again, so release can match the attempt that created the hold.
-- A stale attempt's release then leaves the newer reservation in place.
-- Additive: code that does not read the column sees the same rows. Default 1 is
-- the generation of every row that already exists.
-- Revert: ALTER TABLE ai_usage DROP COLUMN reservation_gen;

ALTER TABLE ai_usage ADD COLUMN reservation_gen bigint NOT NULL DEFAULT 1;
