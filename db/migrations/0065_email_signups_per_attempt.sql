-- One pending signup row per attempt, not per address. With one row per address a second signup for the same email
-- replaced the waiting row's password and revoked its link, so whoever signed up last chose the password the first
-- person's verify mail would set. Each attempt now keeps its own password and link; verifying one deletes the rest.
-- Lookups by address use idx_email_signups_email_lower (0028). Idempotent; drops a constraint only.
ALTER TABLE email_signups DROP CONSTRAINT IF EXISTS email_signups_email_key;
