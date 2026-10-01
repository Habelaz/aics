import { rows, one, type Queryable } from '../../db/types.js';
import type { Role } from '../../domain/enums.js';

export type AdminUser = {
  id: number;
  email: string;
  password_hash: string;
  role: Role;
  is_active: boolean;
  created_at: Date;
  last_login_at: Date | null;
};

export function makeAdminUserRepo(db: Queryable) {
  return {
    async findById(id: number): Promise<AdminUser | null> {
      return one<AdminUser>(db, 'SELECT * FROM admin_users WHERE id = $1', [id]);
    },

    async findByEmail(email: string): Promise<AdminUser | null> {
      return one<AdminUser>(db, 'SELECT * FROM admin_users WHERE lower(email) = lower($1)', [
        email,
      ]);
    },

    async listActive(limit = 100): Promise<AdminUser[]> {
      return rows<AdminUser>(
        db,
        'SELECT * FROM admin_users WHERE is_active ORDER BY email LIMIT $1',
        [limit],
      );
    },

    async create(input: { email: string; passwordHash: string; role?: Role }): Promise<AdminUser> {
      const created = await one<AdminUser>(
        db,
        `INSERT INTO admin_users (email, password_hash, role)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [input.email, input.passwordHash, input.role ?? 'agent'],
      );
      if (!created) throw new Error('admin_users insert returned no row');
      return created;
    },

    async touchLastLogin(id: number): Promise<void> {
      await db.query('UPDATE admin_users SET last_login_at = NOW() WHERE id = $1', [id]);
    },
  };
}

export type AdminUserRepo = ReturnType<typeof makeAdminUserRepo>;