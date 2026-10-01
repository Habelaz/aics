import { count, one, rows, type Queryable } from '../../db/types.js';
import type { DecisionChannel, TicketStatus } from '../../domain/enums.js';

export type EscalationTicket = {
  id: number;
  conversation_id: number | null;
  status: TicketStatus;
  assigned_to: string | null;
  notes: string | null;
  created_at: Date;
  resolved_at: Date | null;
  request_id: string | null;
  decided_by: number | null;
  decided_by_slack: string | null;
  decided_at: Date | null;
  decision_channel: DecisionChannel | null;
};

/**
 * Who made a decision, and through which identity system.
 *
 * Slack approvers are not admin_users, so they cannot populate decided_by
 * without turning an FK into a free-text field. Keeping the two identities in
 * separate columns preserves the referential guarantee for dashboard actions
 * while still recording who clicked in Slack.
 */
export type Decision =
  | { channel: 'slack'; slackUserId: string }
  | { channel: 'dashboard' | 'api'; adminUserId: number };

export function decisionColumns(decision: Decision): {
  decided_by: number | null;
  decided_by_slack: string | null;
} {
  if (decision.channel === 'slack') {
    if (!decision.slackUserId) {
      throw new Error('slack decision requires a slackUserId');
    }
    return { decided_by: null, decided_by_slack: decision.slackUserId };
  }

  if (!Number.isInteger(decision.adminUserId)) {
    throw new Error(`${decision.channel} decision requires an adminUserId`);
  }
  return { decided_by: decision.adminUserId, decided_by_slack: null };
}

export type TicketFilters = {
  status?: TicketStatus;
  assignedTo?: string;
  beforeId?: number;
  limit?: number;
};

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export function makeTicketRepo(db: Queryable) {
  return {
    async findById(id: number): Promise<EscalationTicket | null> {
      return one<EscalationTicket>(db, 'SELECT * FROM escalation_tickets WHERE id = $1', [id]);
    },

    async findByRequestId(requestId: string): Promise<EscalationTicket[]> {
      return rows<EscalationTicket>(
        db,
        'SELECT * FROM escalation_tickets WHERE request_id = $1 ORDER BY id',
        [requestId],
      );
    },

    async list(filters: TicketFilters = {}): Promise<EscalationTicket[]> {
      const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const where: string[] = [];
      const params: unknown[] = [];

      if (filters.status) {
        params.push(filters.status);
        where.push(`status = $${params.length}`);
      }
      if (filters.assignedTo) {
        params.push(filters.assignedTo);
        where.push(`assigned_to = $${params.length}`);
      }
      if (filters.beforeId !== undefined) {
        params.push(filters.beforeId);
        where.push(`id < $${params.length}`);
      }

      const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      params.push(limit);

      return rows<EscalationTicket>(
        db,
        `SELECT * FROM escalation_tickets ${clause} ORDER BY id DESC LIMIT $${params.length}`,
        params,
      );
    },

    /**
     * Written by the workflow the moment a low-confidence answer is escalated,
     * before any human has seen it. This is what makes "awaiting a human" an
     * owned, queryable fact rather than an inference from absence.
     */
    async createPending(input: {
      conversationId?: number | null;
      requestId: string;
      notes?: string | null;
    }): Promise<EscalationTicket> {
      const created = await one<EscalationTicket>(
        db,
        `INSERT INTO escalation_tickets (conversation_id, request_id, status, notes)
         VALUES ($1, $2, 'pending', $3)
         RETURNING *`,
        [input.conversationId ?? null, input.requestId, input.notes ?? null],
      );
      if (!created) throw new Error('escalation_tickets insert returned no row');
      return created;
    },

    async decide(input: {
      id: number;
      status: Extract<TicketStatus, 'approved' | 'rejected' | 'timed_out'>;
      decision: Decision;
      notes?: string | null;
    }): Promise<EscalationTicket | null> {
      const cols = decisionColumns(input.decision);
      const status = input.status as string;
      const updated = await one<EscalationTicket>(
        db,
        `UPDATE escalation_tickets
            SET status = $2::varchar,
                decided_by = $3,
                decided_by_slack = $4,
                decided_at = NOW(),
                decision_channel = $5::varchar,
                resolved_at = CASE WHEN $2::varchar IN ('rejected', 'timed_out')
                                   THEN NOW() ELSE resolved_at END,
                notes = COALESCE($6, notes)
          WHERE id = $1 AND status = 'pending'
          RETURNING *`,
        [
          input.id,
          status,
          cols.decided_by,
          cols.decided_by_slack,
          input.decision.channel,
          input.notes ?? null,
        ],
      );
      return updated;
    },

    /**
     * Dashboard triage.
     *
     * Only approved and in_progress may be triaged. Those are the states a
     * human has already decided and an agent now owns; they are excluded from
     * open/pending because moving out of them means making a decision without
     * recording who decided, which escalation_tickets_decider_present_check
     * rejects at the database level. Rejected, timed_out and resolved are
     * excluded too, so a closed ticket can never be silently reopened.
     */
    async triage(input: {
      id: number;
      status?: TicketStatus;
      assignedTo?: string | null;
      notes?: string | null;
    }): Promise<EscalationTicket | null> {
      const nextStatus = (input.status ?? null) as string | null;
      const updated = await one<EscalationTicket>(
        db,
        `UPDATE escalation_tickets
            SET status = COALESCE($2::varchar, status),
                assigned_to = COALESCE($3, assigned_to),
                notes = COALESCE($4, notes),
                resolved_at = CASE WHEN $2::varchar = 'resolved' THEN NOW() ELSE resolved_at END
          WHERE id = $1
            AND (
              status IN ('approved', 'in_progress')
              OR $2::varchar IS NULL
            )
          RETURNING *`,
        [input.id, nextStatus, input.assignedTo ?? null, input.notes ?? null],
      );
      return updated;
    },

    async countByStatus(): Promise<Record<string, number>> {
      const result = await rows<{ status: TicketStatus; n: string }>(
        db,
        'SELECT status, COUNT(*) AS n FROM escalation_tickets GROUP BY status',
      );
      return Object.fromEntries(result.map((r) => [r.status, Number(r.n)]));
    },

    /**
     * Authoritative "awaiting a human" count for the health endpoint. Preferred
     * over n8n's /executions?status=waiting, which is unreliable in some
     * versions and needs a separate API key.
     */
    async countPending(): Promise<number> {
      return count(db, `SELECT COUNT(*) FROM escalation_tickets WHERE status = 'pending'`);
    },

    /**
     * Sweeper for escalations whose execution died before the Slack wait
     * expired. Returns the affected rows so the caller can emit timed_out
     * events rather than only mutating state silently.
     */
    async markStalePendingTimedOut(olderThanMinutes: number): Promise<EscalationTicket[]> {
      return rows<EscalationTicket>(
        db,
        `UPDATE escalation_tickets
            SET status = 'timed_out',
                decided_at = NOW(),
                decision_channel = 'api',
                resolved_at = NOW()
          WHERE status = 'pending'
            AND created_at < NOW() - ($1 || ' minutes')::interval
        RETURNING *`,
        [olderThanMinutes],
      );
    },
  };
}

export type TicketRepo = ReturnType<typeof makeTicketRepo>;