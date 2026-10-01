-- A decided ticket must identify exactly one decider.
--
-- Slack approvers are not necessarily rows in admin_users, so decided_by (FK)
-- and decided_by_slack (Slack's opaque user id) are mutually exclusive rather
-- than one being a fallback for the other. Without this, a bug or a hand-written
-- UPDATE could leave a decided ticket attributed to nobody, or attributed twice,
-- and application code alone would not catch it.
--
-- The invariant is tied to status, not to decided_at, because the writer sets
-- status and a decided_at-based gate can be bypassed by any UPDATE that moves
-- status without touching decided_at.
--
-- Each non-pending status carries a different requirement:
--
--   open, pending    no decider yet; the ticket is still waiting for a human.
--   timed_out        nobody clicked, so there is no human to name. Asserted
--                    positively instead of skipped: the sweeper must stamp
--                    decided_at and mark decision_channel = 'api', so a
--                    timeout can never be confused with a human decision.
--   approved, rejected,
--   in_progress, resolved
--                    a human decided this, so exactly one of the two columns
--                    must be set. in_progress and resolved sit downstream of an
--                    approval and inherit its attribution, which is why triage
--                    refuses to move a ticket out of open/pending.
--
-- Added NOT VALID. escalation_tickets id=2 was approved through Slack on
-- 2026-09-29 and has neither column populated: the workflow at the time wrote
-- only {approved: true} and never persisted the approver's Slack id. There is no
-- honest value to backfill, and inventing one would put a fabricated identity on
-- a real decision, which is the same failure this migration set out to remove.
--
-- NOT VALID means the constraint is enforced on every INSERT and UPDATE from
-- now on, and merely skips the existing row. One consequence to be aware of:
-- until id=2 is attributed, any UPDATE to that row will fail this check.
-- Attribute it (see below), then lock the gate down for everyone else:
--
--   UPDATE escalation_tickets
--      SET decided_by_slack = 'U0XXXXXXX', decided_at = NOW()
--    WHERE id = 2;
--
--   ALTER TABLE escalation_tickets
--     VALIDATE CONSTRAINT escalation_tickets_decider_present_check;

ALTER TABLE escalation_tickets
    DROP CONSTRAINT IF EXISTS escalation_tickets_decider_present_check;

ALTER TABLE escalation_tickets
    ADD CONSTRAINT escalation_tickets_decider_present_check
    CHECK (
        CASE
            WHEN status IN ('open', 'pending')
                THEN TRUE
            WHEN status = 'timed_out'
                THEN decided_at IS NOT NULL AND decision_channel = 'api'
            ELSE (decided_by IS NOT NULL) <> (decided_by_slack IS NOT NULL)
        END
    ) NOT VALID;