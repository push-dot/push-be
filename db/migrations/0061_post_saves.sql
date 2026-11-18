-- A reader saves a community post to read again (MyPostsAllMenuFull: 저장한 글). One row per user and post,
-- idempotent on the key. Both keys cascade: a purged user takes the saves, and a deleted post leaves none behind.
-- Additive: one table and its list index. Revert: DROP TABLE post_saves;

CREATE TABLE post_saves (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, post_id)
);
CREATE INDEX idx_post_saves_list ON post_saves (user_id, created_at DESC, post_id DESC);
CREATE INDEX idx_post_saves_post ON post_saves (post_id);
