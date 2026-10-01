import type { QueryResult, QueryResultRow } from 'pg';

/**
 * The slice of a pg client/pool that repositories depend on. Keeping
 * repositories behind this interface is what lets the unit test layer run
 * without a database.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    queryTextOrConfig: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export async function rows<T extends QueryResultRow>(
  db: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await db.query<T>(text, params as unknown[]);
  return result.rows;
}

export async function one<T extends QueryResultRow>(
  db: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const result = await db.query<T>(text, params as unknown[]);
  return result.rows[0] ?? null;
}

export async function count(
  db: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<number> {
  const result = await db.query<{ count: string }>(text, params as unknown[]);
  return Number(result.rows[0]?.count ?? 0);
}