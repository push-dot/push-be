-- The password of an employer email signup is chosen on the verify page by whoever opens the link, not at signup.
-- With the password taken at signup, two signups for one address left the mailbox owner holding a link that
-- creates the account with a stranger's password. Rows made before this keep their hash; new rows have none.
-- Idempotent.
ALTER TABLE email_signups ALTER COLUMN password_hash DROP NOT NULL;
