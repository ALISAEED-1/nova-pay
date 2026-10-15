import { mkdir } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

import { migrate } from './migrations.js';

export interface QueryResult<T> {
  rows: T[];
  /** Rows returned, or rows changed for an INSERT/UPDATE/DELETE without RETURNING. */
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Runs a multi-statement script without parameters (migrations). */
  exec(sql: string): Promise<void>;
}

/**
 * The small slice of Postgres the service needs. Two implementations: embedded
 * PGlite (no install, used for development and tests) and node-postgres for a
 * real server. Both speak the same SQL.
 */
export interface Db extends Queryable {
  /** Runs `fn` in a transaction: commits if it resolves, rolls back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDb(
  options: { databaseUrl?: string; pgliteDataDir?: string },
  migrateOptions?: { upTo?: number },
): Promise<Db> {
  const db = options.databaseUrl
    ? openPostgres(options.databaseUrl)
    : await openPglite(options.pgliteDataDir);
  await migrate(db, migrateOptions);
  return db;
}

async function openPglite(dataDir?: string): Promise<Db> {
  // PGlite creates only the last folder of the path itself.
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const pglite = await PGlite.create(dataDir);
  const wrap = (q: Pick<PGlite, 'query' | 'exec'>): Queryable => ({
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await q.query<T>(sql, params);
      return { rows: result.rows, rowCount: result.rows.length || (result.affectedRows ?? 0) };
    },
    exec: async (sql) => {
      await q.exec(sql);
    },
  });
  return {
    ...wrap(pglite),
    transaction: (fn) => pglite.transaction((tx) => fn(wrap(tx))),
    close: () => pglite.close(),
  };
}

function openPostgres(connectionString: string): Db {
  // BIGINT columns hold minor-unit amounts, all far below 2^53.
  pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
  const pool = new pg.Pool({ connectionString });
  const wrap = (client: pg.Pool | pg.PoolClient): Queryable => ({
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
    },
    exec: async (sql) => {
      await client.query(sql);
    },
  });
  return {
    ...wrap(pool),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await fn(wrap(client));
        await client.query('COMMIT');
        return value;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
