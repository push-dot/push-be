-- Older code inserts shares without expires_at; default it so those inserts keep working.
ALTER TABLE conversation_shares
    ALTER COLUMN expires_at SET DEFAULT now() + interval '30 days';
