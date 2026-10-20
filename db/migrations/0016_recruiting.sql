-- v2 recruiting tables. Seed rows live in services/ai/scripts/seed_local.py,
-- which refuses to run unless APP_ENV=development.
-- Apply this file by hand on the production database. It is not part of deploy.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE users ADD COLUMN is_employer boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN email text;

ALTER TABLE jobs ADD COLUMN search_choseong text NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN search_jamo text NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN source_posting_id uuid;

CREATE TABLE job_postings (
    id uuid PRIMARY KEY,
    company_user_id uuid NOT NULL REFERENCES users(id),
    company text NOT NULL,
    title text NOT NULL,
    job_category text NOT NULL,
    career_min int NOT NULL,
    career_max int,
    location text NOT NULL,
    employment_type text NOT NULL,
    description text NOT NULL,
    requirements jsonb NOT NULL DEFAULT '[]',
    work_conditions jsonb NOT NULL DEFAULT '{}',
    skills jsonb NOT NULL DEFAULT '[]',
    image_key text,
    source_url text,
    deadline date,
    closed_at timestamptz,
    search_text text NOT NULL DEFAULT '',
    search_choseong text NOT NULL DEFAULT '',
    search_jamo text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT job_postings_category_chk CHECK (job_category IN ('dev', 'data', 'design', 'plan', 'marketing', 'sales', 'hr', 'ops')),
    CONSTRAINT job_postings_employment_chk CHECK (employment_type IN ('full_time', 'contract', 'intern', 'freelance', 'dispatch')),
    CONSTRAINT job_postings_career_chk CHECK (career_min >= 0 AND (career_max IS NULL OR career_max >= career_min))
);

ALTER TABLE jobs
    ADD CONSTRAINT jobs_source_posting_fk
    FOREIGN KEY (source_posting_id) REFERENCES job_postings(id);

CREATE INDEX idx_postings_list ON job_postings (created_at DESC, id DESC);
CREATE INDEX idx_postings_title_trgm ON job_postings USING gin (title gin_trgm_ops);
CREATE INDEX idx_postings_company_trgm ON job_postings USING gin (company gin_trgm_ops);
CREATE INDEX idx_postings_choseong_trgm ON job_postings USING gin (search_choseong gin_trgm_ops);
CREATE INDEX idx_postings_jamo_trgm ON job_postings USING gin (search_jamo gin_trgm_ops);
CREATE INDEX idx_jobs_title_trgm ON jobs USING gin (title gin_trgm_ops);
CREATE INDEX idx_jobs_company_trgm ON jobs USING gin (company gin_trgm_ops);
CREATE INDEX idx_jobs_choseong_trgm ON jobs USING gin (search_choseong gin_trgm_ops);
CREATE INDEX idx_jobs_jamo_trgm ON jobs USING gin (search_jamo gin_trgm_ops);

CREATE TABLE profiles (
    user_id uuid PRIMARY KEY REFERENCES users(id),
    headline text NOT NULL DEFAULT '',
    job_category text,
    tenure_years int,
    career_status text,
    open_to_offers boolean NOT NULL DEFAULT true,
    intro text NOT NULL DEFAULT '',
    careers jsonb NOT NULL DEFAULT '[]',
    skills jsonb NOT NULL DEFAULT '[]',
    avatar_key text,
    resume_source_id uuid REFERENCES sources(id),
    search_text text NOT NULL DEFAULT '',
    search_choseong text NOT NULL DEFAULT '',
    search_jamo text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT profiles_category_chk CHECK (job_category IS NULL OR job_category IN ('dev', 'data', 'design', 'plan', 'marketing', 'sales', 'hr', 'ops')),
    CONSTRAINT profiles_status_chk CHECK (career_status IS NULL OR career_status IN ('satisfied', 'seeking', 'feedback')),
    CONSTRAINT profiles_tenure_chk CHECK (tenure_years IS NULL OR tenure_years >= 0)
);

CREATE INDEX idx_profiles_text_trgm ON profiles USING gin (search_text gin_trgm_ops);
CREATE INDEX idx_profiles_choseong_trgm ON profiles USING gin (search_choseong gin_trgm_ops);
CREATE INDEX idx_profiles_jamo_trgm ON profiles USING gin (search_jamo gin_trgm_ops);

CREATE TABLE bookmarks (
    user_id uuid NOT NULL REFERENCES users(id),
    posting_id uuid NOT NULL REFERENCES job_postings(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, posting_id)
);
CREATE INDEX idx_bookmarks_list ON bookmarks (user_id, created_at DESC, posting_id DESC);

CREATE TABLE follows (
    follower_id uuid NOT NULL REFERENCES users(id),
    followee_id uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followee_id),
    CONSTRAINT follows_not_self CHECK (follower_id <> followee_id)
);
CREATE INDEX idx_follows_followee ON follows (followee_id, created_at DESC, follower_id DESC);

CREATE TABLE offers (
    id uuid PRIMARY KEY,
    sender_id uuid NOT NULL REFERENCES users(id),
    profile_user_id uuid NOT NULL REFERENCES users(id),
    message text NOT NULL,
    posting_id uuid REFERENCES job_postings(id),
    status text NOT NULL DEFAULT 'SENT',
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT offers_status_chk CHECK (status IN ('SENT', 'READ', 'ACCEPTED', 'DECLINED')),
    CONSTRAINT offers_not_self CHECK (sender_id <> profile_user_id),
    UNIQUE (sender_id, profile_user_id)
);
CREATE INDEX idx_offers_received ON offers (profile_user_id, created_at DESC, id DESC);
CREATE INDEX idx_offers_sent ON offers (sender_id, created_at DESC, id DESC);

CREATE TABLE offer_messages (
    id uuid PRIMARY KEY,
    offer_id uuid NOT NULL REFERENCES offers(id),
    sender_id uuid NOT NULL REFERENCES users(id),
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_offer_messages_list ON offer_messages (offer_id, created_at DESC, id DESC);

CREATE TABLE user_links (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    kind text NOT NULL,
    url text NOT NULL,
    title text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'READ',
    fit_count int NOT NULL DEFAULT 0,
    ai_read boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_links_kind_chk CHECK (kind IN ('job', 'github', 'portfolio', 'blog', 'other')),
    CONSTRAINT user_links_status_chk CHECK (status IN ('READING', 'READ'))
);
CREATE INDEX idx_user_links_list ON user_links (user_id, created_at DESC, id DESC);

CREATE TABLE posts (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    category text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    image_keys jsonb NOT NULL DEFAULT '[]',
    view_count int NOT NULL DEFAULT 0,
    search_text text NOT NULL DEFAULT '',
    search_choseong text NOT NULL DEFAULT '',
    search_jamo text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT posts_category_chk CHECK (category IN ('work', 'dev', 'daily', 'career', 'talk', 'coffeechat', 'marketing'))
);
CREATE INDEX idx_posts_list ON posts (created_at DESC, id DESC);
CREATE INDEX idx_posts_category_list ON posts (category, created_at DESC, id DESC);
CREATE INDEX idx_posts_user_list ON posts (user_id, created_at DESC, id DESC);
CREATE INDEX idx_posts_title_trgm ON posts USING gin (title gin_trgm_ops);
CREATE INDEX idx_posts_choseong_trgm ON posts USING gin (search_choseong gin_trgm_ops);
CREATE INDEX idx_posts_jamo_trgm ON posts USING gin (search_jamo gin_trgm_ops);

CREATE TABLE post_comments (
    id uuid PRIMARY KEY,
    post_id uuid NOT NULL REFERENCES posts(id),
    user_id uuid NOT NULL REFERENCES users(id),
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_post_comments_list ON post_comments (post_id, created_at DESC, id DESC);
CREATE INDEX idx_post_comments_user ON post_comments (user_id, created_at DESC, id DESC);

CREATE TABLE user_devices (
    user_id uuid NOT NULL REFERENCES users(id),
    token text NOT NULL,
    platform text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, token),
    CONSTRAINT user_devices_platform_chk CHECK (platform IN ('ios', 'android'))
);

CREATE TABLE notifications (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    type text NOT NULL,
    title text NOT NULL,
    body text NOT NULL DEFAULT '',
    target jsonb NOT NULL DEFAULT '{}',
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notifications_type_chk CHECK (type IN ('DEADLINE', 'OFFER', 'COMMENT', 'AI_DONE'))
);
CREATE INDEX idx_notifications_list ON notifications (user_id, created_at DESC, id DESC);

CREATE TABLE user_settings (
    user_id uuid PRIMARY KEY REFERENCES users(id),
    notify_deadline boolean NOT NULL DEFAULT true,
    notify_offer boolean NOT NULL DEFAULT true,
    notify_comment boolean NOT NULL DEFAULT true,
    notify_ai_done boolean NOT NULL DEFAULT true,
    profile_public boolean NOT NULL DEFAULT true,
    career_status_visibility text NOT NULL DEFAULT 'everyone',
    hide_from_current_company boolean NOT NULL DEFAULT false,
    contact_visibility text NOT NULL DEFAULT 'accepted',
    default_tone text NOT NULL DEFAULT 'as_is',
    chat_retention_days int,
    allow_ai_read_my_files boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_settings_visibility_chk CHECK (career_status_visibility IN ('everyone', 'followers', 'private')),
    CONSTRAINT user_settings_contact_chk CHECK (contact_visibility IN ('accepted', 'followers', 'everyone', 'private')),
    CONSTRAINT user_settings_tone_chk CHECK (default_tone IN ('as_is', 'professional', 'confident', 'concise', 'technical', 'friendly'))
);
