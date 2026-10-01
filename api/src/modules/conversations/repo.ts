import { count, one, rows, type Queryable } from '../../db/types.js';
import type { Confidence } from '../../domain/enums.js';

export type Conversation = {
  id: number;
  question: string;
  answer: string;
  confidence: Confidence;
  created_at: Date;
  /** NULL for rows that predate request tracking. See migration 008. */
  request_id: string | null;
  session_id: string | null;
  sources: unknown;
  latency_ms: number | null;
  approved: boolean | null;
  decision_channel: string | null;
};

export type ConversationFilters = {
  confidence?: Confidence;
  q?: string;
  from?: Date;
  to?: Date;
  sessionId?: string;
  beforeId?: number;
  limit?: number;
};

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export function makeConversationRepo(db: Queryable) {
  return {
    /**
     * Read path. The production writer is the n8n workflow's Log to Postgres
     * node — see docs/stage5-plan.md §2.2. This repo never writes rows in the
     * request path; the insert below exists for seeding and tests.
     */
    /**
     * Correlation lookup for a request_id minted by the API. Legacy rows have a
     * NULL request_id and are deliberately unreachable from here, which is why
     * this never returns them.
     */
    async findByRequestId(requestId: string): Promise<Conversation | null> {
      return one<Conversation>(db, 'SELECT * FROM conversations WHERE request_id = $1', [
        requestId,
      ]);
    },

    async findById(id: number): Promise<Conversation | null> {
      return one<Conversation>(db, 'SELECT * FROM conversations WHERE id = $1', [id]);
    },

    async list(filters: ConversationFilters = {}): Promise<Conversation[]> {
      const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const where: string[] = [];
      const params: unknown[] = [];

      if (filters.confidence) {
        params.push(filters.confidence);
        where.push(`confidence = $${params.length}`);
      }
      if (filters.sessionId) {
        params.push(filters.sessionId);
        where.push(`session_id = $${params.length}`);
      }
      if (filters.q) {
        params.push(`%${filters.q}%`);
        where.push(`(question ILIKE $${params.length} OR answer ILIKE $${params.length})`);
      }
      if (filters.from) {
        params.push(filters.from);
        where.push(`created_at >= $${params.length}`);
      }
      if (filters.to) {
        params.push(filters.to);
        where.push(`created_at <= $${params.length}`);
      }
      if (filters.beforeId !== undefined) {
        params.push(filters.beforeId);
        where.push(`id < $${params.length}`);
      }

      const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      params.push(limit);

      return rows<Conversation>(
        db,
        `SELECT * FROM conversations ${clause} ORDER BY id DESC LIMIT $${params.length}`,
        params,
      );
    },

    async insert(input: {
      question: string;
      answer: string;
      confidence: Confidence;
      /**
       * Optional only for legacy rows. Production inserts come from the n8n
       * workflow, which always receives a request_id minted by the API.
       */
      requestId?: string | null;
      sessionId?: string | null;
      sources?: unknown[];
      latencyMs?: number | null;
    }): Promise<Conversation> {
      const created = await one<Conversation>(
        db,
        `INSERT INTO conversations
           (question, answer, confidence, request_id, session_id, sources, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING *`,
        [
          input.question,
          input.answer,
          input.confidence,
          input.requestId ?? null,
          input.sessionId ?? null,
          JSON.stringify(input.sources ?? []),
          input.latencyMs ?? null,
        ],
      );
      if (!created) throw new Error('conversations insert returned no row');
      return created;
    },

    async countByConfidence(): Promise<Record<string, number>> {
      const result = await rows<{ confidence: Confidence; n: string }>(
        db,
        'SELECT confidence, COUNT(*) AS n FROM conversations GROUP BY confidence',
      );
      return Object.fromEntries(result.map((r) => [r.confidence, Number(r.n)]));
    },

    async count(): Promise<number> {
      return count(db, 'SELECT COUNT(*) FROM conversations');
    },
  };
}

export type ConversationRepo = ReturnType<typeof makeConversationRepo>;