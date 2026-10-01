-- Ticket lifecycle.
--
-- 'pending' is a first-class state: written the moment a low-confidence answer
-- is escalated to Slack, before any human has looked at it. This is what makes
-- "awaiting a human" a queryable, owned fact rather than an inference.
--
-- timed_out is deliberately distinct from rejected. "A human declined this" and
-- "nobody clicked" are different operational signals.
--
-- decided_by is an FK for dashboard-driven decisions (it must survive a
-- renamed or deactivated admin). Slack decisions come from users that do not
-- exist in admin_users, so they land in decided_by_slack as Slack's stable
-- opaque user id, recorded alongside decision_channel.

ALTER TABLE escalation_tickets
    ADD COLUMN IF NOT EXISTS request_id        UUID,
    ADD COLUMN IF NOT EXISTS decided_by        INTEGER
        REFERENCES admin_users (id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS decided_by_slack  VARCHAR(32),
    ADD COLUMN IF NOT EXISTS decided_at        TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS decision_channel  VARCHAR(20)
        CHECK (decision_channel IN ('slack', 'dashboard', 'api'));

ALTER TABLE escalation_tickets
    DROP CONSTRAINT IF EXISTS escalation_tickets_status_check;

ALTER TABLE escalation_tickets
    ADD CONSTRAINT escalation_tickets_status_check
    CHECK (status IN ('open', 'pending', 'approved', 'rejected',
                      'timed_out', 'in_progress', 'resolved'));

CREATE INDEX IF NOT EXISTS escalation_tickets_request_id_idx
    ON escalation_tickets (request_id);
CREATE INDEX IF NOT EXISTS escalation_tickets_status_created_idx
    ON escalation_tickets (status, created_at DESC);