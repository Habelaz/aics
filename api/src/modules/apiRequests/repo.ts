import { count, one, rows, type Queryable } from '../../db/types.js';
import type { RequestState } from '../../domain/enums.js';

export type ApiRequest = {
  request_id: string;
  session_id: string | null;
  question: string;
  received_at: Date;
  state: RequestState;
  upstream_http: number | null;
  upstream_error: string | null;
  latency_ms: number | null;
  updated_at: Date;
};

export function makeApiRequestRepo(db: Queryable) {
  return {
    async create(input: {
      requestId: string;
      question: string;
      sessionId?: string | null;
    }): Promise<ApiRequest> {
      const created = await one<ApiRequest>(
        db,
        `INSERT INTO api_requests (request_id, session_id, question)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [input.requestId, input.sessionId ?? null, input.question],
      );
      if (!created) throw new Error('api_requests insert returned no row');
      return created;
    },

    async findById(requestId: string): Promise<ApiRequest | null> {
      return one<ApiRequest>(db, 'SELECT * FROM api_requests WHERE request_id = $1', [requestId]);
    },

    async updateState(input: {
      requestId: string;
      state: RequestState;
      upstreamHttp?: number | null;
      upstreamError?: string | null;
      latencyMs?: number | null;
    }): Promise<ApiRequest | null> {
      const updated = await one<ApiRequest>(
        db,
        `UPDATE api_requests
            SET state = $2,
                upstream_http = COALESCE($3, upstream_http),
                upstream_error = COALESCE($4, upstream_error),
                latency_ms = COALESCE($5, latency_ms),
                updated_at = NOW()
          WHERE request_id = $1
        RETURNING *`,
        [
          input.requestId,
          input.state,
          input.upstreamHttp ?? null,
          input.upstreamError ?? null,
          input.latencyMs ?? null,
        ],
      );
      return updated;
    },

    async countByState(): Promise<Record<string, number>> {
      const result = await rows<{ state: RequestState; n: string }>(
        db,
        'SELECT state, COUNT(*) AS n FROM api_requests GROUP BY state',
      );
      return Object.fromEntries(result.map((r) => [r.state, Number(r.n)]));
    },

    /**
     * Upstream failure rate over a window. This is the only place a Gemini 503
     * or an n8n 200-with-empty-body becomes visible: the workflow cannot report
     * its own failures, so they are recorded here at the edge instead.
     */
    async failureRateSince(since: Date): Promise<{ total: number; failed: number; rate: number }> {
      const result = await rows<{ total: string; failed: string }>(
        db,
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE state = 'failed') AS failed
           FROM api_requests
          WHERE received_at >= $1`,
        [since],
      );
      const total = Number(result[0]?.total ?? 0);
      const failed = Number(result[0]?.failed ?? 0);
      return { total, failed, rate: total === 0 ? 0 : failed / total };
    },

    async count(): Promise<number> {
      return count(db, 'SELECT COUNT(*) FROM api_requests');
    },
  };
}

export type ApiRequestRepo = ReturnType<typeof makeApiRequestRepo>;