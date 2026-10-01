import { rows, type Queryable } from '../../db/types.js';

export type AuditEntry = {
  id: string;
  actor_id: number | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  at: Date;
};

export type AuditChange = { before: unknown; after: unknown };

export function makeAuditLogRepo(db: Queryable) {
  return {
    /**
     * Append-only. Written in the same transaction as the mutation it
     * describes, so the audit trail cannot drift from the data.
     */
    async record(input: {
      actorId: number | null;
      action: string;
      entity: string;
      entityId?: string | number | null;
      change?: AuditChange;
      ip?: string | null;
    }): Promise<void> {
      await db.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after, ip)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::inet)`,
        [
          input.actorId,
          input.action,
          input.entity,
          input.entityId === undefined || input.entityId === null ? null : String(input.entityId),
          input.change ? JSON.stringify(input.change.before) : null,
          input.change ? JSON.stringify(input.change.after) : null,
          input.ip ?? null,
        ],
      );
    },

    async listByEntity(entity: string, entityId: string | number, limit = 50): Promise<AuditEntry[]> {
      return rows<AuditEntry>(
        db,
        'SELECT * FROM audit_log WHERE entity = $1 AND entity_id = $2 ORDER BY at DESC LIMIT $3',
        [entity, String(entityId), limit],
      );
    },

    async listRecent(limit = 50): Promise<AuditEntry[]> {
      return rows<AuditEntry>(db, 'SELECT * FROM audit_log ORDER BY at DESC LIMIT $1', [limit]);
    },
  };
}

export type AuditLogRepo = ReturnType<typeof makeAuditLogRepo>;