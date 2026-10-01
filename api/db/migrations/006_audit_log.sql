-- Append-only record of every privileged mutation.
--
-- Ticket status changes made through the dashboard are written here in the
-- same transaction as the change itself, so the audit trail cannot drift from
-- the data it describes.

CREATE TABLE IF NOT EXISTS audit_log (
    id         BIGSERIAL PRIMARY KEY,
    actor_id   INTEGER REFERENCES admin_users (id) ON DELETE SET NULL,
    action     VARCHAR(40)  NOT NULL,
    entity     VARCHAR(40)  NOT NULL,
    entity_id  TEXT,
    before     JSONB,
    after      JSONB,
    ip         INET,
    at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);