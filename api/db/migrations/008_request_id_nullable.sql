-- Reverses the synthetic request_id backfill from 003.
--
-- 003 backfilled rows that predate request tracking with gen_random_uuid()
-- and then set NOT NULL to protect the correlation invariant. That traded a
-- real problem for a worse one: those UUIDs look like genuine correlation keys
-- but can never match an api_requests row. Anyone following one hits a dead end
-- with no way to tell that it was never real.
--
-- A NULL request_id is honest: it means "this predates request tracking".
-- Postgres permits many NULLs in a unique column, so conversations_request_id_idx
-- still enforces uniqueness for every row that actually has one.
--
-- The correlation invariant is not abandoned, it moves to the writer. The API
-- mints the request_id and passes it in the webhook body, so the n8n insert is
-- the only path that can omit it, and that is validated in the workflow rather
-- than being papered over in the schema.

ALTER TABLE conversations
    ALTER COLUMN request_id DROP NOT NULL;

-- Only clear the values that were fabricated. A request_id that matches an
-- api_requests row is genuine and must survive.
UPDATE conversations c
   SET request_id = NULL
 WHERE c.request_id IS NOT NULL
   AND NOT EXISTS (
       SELECT 1 FROM api_requests r WHERE r.request_id = c.request_id
   );

-- Non-null request_ids are now the norm, so index them directly rather than
-- carrying every legacy NULL through the index.
DROP INDEX IF EXISTS conversations_request_id_idx;
CREATE UNIQUE INDEX conversations_request_id_idx
    ON conversations (request_id)
    WHERE request_id IS NOT NULL;