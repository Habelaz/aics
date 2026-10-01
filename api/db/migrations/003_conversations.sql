-- Correlation columns for conversations.
--
-- request_id is the UUID minted by the API and passed into the n8n webhook
-- body. It is NOT NULL so the correlation invariant cannot be violated
-- silently: if the workflow ever omits it, the insert fails loudly instead of
-- producing an orphaned row that no join will ever reach.
--
-- Rows predating the API layer are backfilled with generated UUIDs. They are
-- synthetic placeholders and have no matching api_requests row.

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS request_id    UUID,
    ADD COLUMN IF NOT EXISTS session_id    VARCHAR(64),
    ADD COLUMN IF NOT EXISTS sources       JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS latency_ms    INTEGER,
    ADD COLUMN IF NOT EXISTS approved      BOOLEAN,
    ADD COLUMN IF NOT EXISTS decision_channel VARCHAR(20);

UPDATE conversations SET request_id = gen_random_uuid() WHERE request_id IS NULL;

ALTER TABLE conversations ALTER COLUMN request_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_request_id_idx
    ON conversations (request_id);
CREATE INDEX IF NOT EXISTS conversations_confidence_created_idx
    ON conversations (confidence, created_at DESC);