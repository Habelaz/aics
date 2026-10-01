import { Pool, type PoolClient } from 'pg';
import { loadEnv, type Env } from '../config/env.js';

let cached: Env | undefined;

function config(): Env {
  cached ??= loadEnv();
  return cached;
}

let primaryPool: Pool | undefined;
let readOnlyN8nPool: Pool | undefined;

/**
 * Pools are created lazily rather than at import time. Importing this module
 * must not require a valid environment, otherwise a CLI entry point that loads
 * .env after its imports would already have thrown.
 */
export function getPool(): Pool {
  if (!primaryPool) {
    primaryPool = new Pool({
      connectionString: config().DATABASE_URL,
      max: config().PGPOOL_MAX,
      application_name: 'aics-api',
    });
    primaryPool.on('error', (err) => {
      process.stderr.write(`[db] idle client error: ${err.message}\n`);
    });
  }
  return primaryPool;
}

/**
 * Connection to n8n's internal database. Used only for the execution-count
 * health metric, which reads n8n's REST /executions endpoint unreliably in
 * some versions. Kept separate so the boundary is visible at every call site.
 */
export function getN8nPool(): Pool {
  if (!readOnlyN8nPool) {
    readOnlyN8nPool = new Pool({
      connectionString: config().N8N_DATABASE_URL,
      max: 2,
      application_name: 'aics-api-n8n-readonly',
    });
    readOnlyN8nPool.on('error', (err) => {
      process.stderr.write(`[db:n8n] idle client error: ${err.message}\n`);
    });
  }
  return readOnlyN8nPool;
}

export async function withTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePools(): Promise<void> {
  const closing = [primaryPool, readOnlyN8nPool].filter((p): p is Pool => p !== undefined);
  primaryPool = undefined;
  readOnlyN8nPool = undefined;
  await Promise.allSettled(closing.map((p) => p.end()));
}