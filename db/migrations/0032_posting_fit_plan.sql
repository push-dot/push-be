UPDATE posting_fit_cache SET plan = 'FREE' WHERE btrim(plan) = '';

ALTER TABLE posting_fit_cache DROP CONSTRAINT posting_fit_cache_pkey;
ALTER TABLE posting_fit_cache ADD PRIMARY KEY (user_id, posting_id, document_id, plan);
