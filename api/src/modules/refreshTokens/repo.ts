import { rows, one, type Queryable } from '../../db/types.js';

export type RefreshToken = {
  id: number;
  user_id: number;
  family_id: string;
  token_hash: string;
  expires_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
  created_at: Date;
};

/**
 * Why a token family was revoked. `reuse` is the security signal: a token that
 * was already rotated or revoked was presented again, which means either the
 * legitimate client replayed it or a leaked copy is in use.
 */
export type RevokeReason = 'logout' | 'reuse' | 'expired' | 'admin';

export function makeRefreshTokenRepo(db: Queryable) {
  return {
    async create(input: {
      userId: number;
      familyId: string;
      tokenHash: string;
      expiresAt: Date;
    }): Promise<RefreshToken> {
      const created = await one<RefreshToken>(
        db,
        `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [input.userId, input.familyId, input.tokenHash, input.expiresAt],
      );
      if (!created) throw new Error('refresh_tokens insert returned no row');
      return created;
    },

    async findByHash(tokenHash: string): Promise<RefreshToken | null> {
      return one<RefreshToken>(db, 'SELECT * FROM refresh_tokens WHERE token_hash = $1', [
        tokenHash,
      ]);
    },

    async listFamily(familyId: string): Promise<RefreshToken[]> {
      return rows<RefreshToken>(
        db,
        'SELECT * FROM refresh_tokens WHERE family_id = $1 ORDER BY id',
        [familyId],
      );
    },

    /**
     * Marks a token as rotated. The caller must have already issued its
     * replacement in the same family.
     */
    async markRotated(id: number): Promise<void> {
      await db.query(
        'UPDATE refresh_tokens SET rotated_at = NOW() WHERE id = $1 AND rotated_at IS NULL',
        [id],
      );
    },

    async revoke(id: number, reason: RevokeReason): Promise<void> {
      await db.query(
        `UPDATE refresh_tokens
            SET revoked_at = NOW(), revoked_reason = $2
          WHERE id = $1 AND revoked_at IS NULL`,
        [id, reason],
      );
    },

    /**
     * Revokes every live token in a family. Used when reuse is detected: the
     * attacker and the legitimate client are indistinguishable at that point,
     * so the whole lineage is burned and both are forced to re-authenticate.
     */
    async revokeFamily(familyId: string, reason: RevokeReason): Promise<number> {
      const result = await db.query(
        `UPDATE refresh_tokens
            SET revoked_at = NOW(), revoked_reason = $2
          WHERE family_id = $1 AND revoked_at IS NULL`,
        [familyId, reason],
      );
      return result.rowCount ?? 0;
    },

    async deleteExpired(): Promise<number> {
      const result = await db.query('DELETE FROM refresh_tokens WHERE expires_at < NOW()');
      return result.rowCount ?? 0;
    },
  };
}

export type RefreshTokenRepo = ReturnType<typeof makeRefreshTokenRepo>;