import { rows } from '../../db/types.js';
import { getN8nPool, getPool } from '../../db/pool.js';
import { makeTicketRepo } from '../tickets/repo.js';
import { makeApiRequestRepo } from '../apiRequests/repo.js';

export type ExecutionCounts = Record<string, number>;

export type HealthSnapshot = {
  pendingEscalations: number;
  apiRequests: Record<string, number>;
  n8nExecutions: ExecutionCounts;
  upstreamFailureRate: { total: number; failed: number; rate: number };
  degraded: boolean;
};

const FAILURE_WINDOW_HOURS = 24;
const DEGRADED_FAILURE_RATE = 0.25;

export function makeHealthRepo() {
  return {
    /**
     * n8n execution counts read straight from the n8n database rather than its
     * REST /executions endpoint: that endpoint needs a separate API key and
     * does not reliably report `waiting` executions in some n8n versions,
     * which would make a dashboard tile read zero during a real incident.
     */
    async n8nExecutionCounts(): Promise<ExecutionCounts> {
      const result = await rows<{ status: string; n: string }>(
        getN8nPool(),
        'SELECT status, COUNT(*) AS n FROM execution_entity GROUP BY status',
      );
      return Object.fromEntries(result.map((r) => [r.status, Number(r.n)]));
    },

    async snapshot(): Promise<HealthSnapshot> {
      const db = getPool();
      const tickets = makeTicketRepo(db);
      const requests = makeApiRequestRepo(db);
      const health = makeHealthRepo();

      const [pendingEscalations, apiRequests, n8nExecutions, upstreamFailureRate] =
        await Promise.all([
          tickets.countPending(),
          requests.countByState(),
          health.n8nExecutionCounts(),
          requests.failureRateSince(new Date(Date.now() - FAILURE_WINDOW_HOURS * 3_600_000)),
        ]);

      return {
        pendingEscalations,
        apiRequests,
        n8nExecutions,
        upstreamFailureRate,
        degraded:
          upstreamFailureRate.total >= 5 && upstreamFailureRate.rate >= DEGRADED_FAILURE_RATE,
      };
    },
  };
}

export type HealthRepo = ReturnType<typeof makeHealthRepo>;