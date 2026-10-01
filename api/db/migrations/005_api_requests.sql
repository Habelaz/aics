-- The API's own record of every request it accepted.
--
-- This table exists because the workflow cannot report its own failures: n8n
-- returns HTTP 200 with an empty body when a run errors, so an upstream 503 is
-- invisible unless it is recorded here at the edge. Without it, a Gemini
-- outage looks identical to a quiet afternoon.

CREATE TABLE IF NOT EXISTS api_requests (
    request_id     UUID PRIMARY KEY,
    session_id     VARCHAR(64),
    question       TEXT NOT NULL,
    received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    state          VARCHAR(20) NOT NULL DEFAULT 'accepted'
                   CHECK (state IN ('accepted', 'answered', 'escalated',
                                    'approved', 'rejected', 'timed_out', 'failed')),
    upstream_http  INTEGER,
    upstream_error TEXT,
    latency_ms     INTEGER,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_requests_state_idx ON api_requests (state);
CREATE INDEX IF NOT EXISTS api_requests_received_idx
    ON api_requests (received_at DESC);