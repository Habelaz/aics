-- Admin accounts for the dashboard. Created first because
-- escalation_tickets.decided_by references it.

CREATE TABLE IF NOT EXISTS admin_users (
    id             SERIAL PRIMARY KEY,
    email          VARCHAR(255) NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    role           VARCHAR(20)  NOT NULL DEFAULT 'agent'
                   CHECK (role IN ('admin', 'agent')),
    is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_login_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS admin_users_active_idx
    ON admin_users (is_active)
    WHERE is_active;