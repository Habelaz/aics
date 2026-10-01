-- Refresh tokens with rotation + reuse detection.
--
-- family_id groups every token descended from a single login. Presenting a
-- token that is already rotated_at or revoked_at is treated as theft, and the
-- whole family is revoked rather than just that row. Without family_id this
-- cannot be retrofitted without touching every active session.

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id             SERIAL PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
    family_id      UUID    NOT NULL,
    token_hash     TEXT    NOT NULL UNIQUE,
    expires_at     TIMESTAMPTZ NOT NULL,
    rotated_at     TIMESTAMPTZ,
    revoked_at     TIMESTAMPTZ,
    revoked_reason VARCHAR(40),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_live_idx
    ON refresh_tokens (token_hash)
    WHERE revoked_at IS NULL;