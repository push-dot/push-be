-- The fit judge now scores 기술 스택 and 키워드 in code and the other three on an anchored scale.
-- Cached rows from the old rubric would rank beside new ones in one list and one minFit filter, and
-- core-api reads fit_score straight from this table, so a version in the cache key would not hide them.
-- A cache: deleting it loses nothing; the next read scores the pair again.
-- Apply with the deploy of the new judge. Rows the old code writes between this migration and the
-- rollout stay until the document or posting changes.
-- Revert: none needed (the rows are recomputed on demand).

DELETE FROM posting_fit_cache;
