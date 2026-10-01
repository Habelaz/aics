-- Partial index backing the stale-pending sweeper, which marks tickets that sat
-- in 'pending' past the Slack wait window as 'timed_out'. Without this the
-- sweeper degrades into a sequential scan as the table grows.
--
-- The sweeper threshold and the workflow's Slack limitWaitTime must stay in
-- step; both read the same env var.

CREATE INDEX IF NOT EXISTS escalation_tickets_pending_age_idx
    ON escalation_tickets (created_at)
    WHERE status = 'pending';