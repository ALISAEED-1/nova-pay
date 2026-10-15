import type { Db } from './index.js';
import { INITIAL_SCHEMA } from './schema.js';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Ordered, append-only schema changes. Each runs once, in its own transaction,
 * and is recorded in `schema_migrations`. Never edit one that has shipped; add
 * a new one instead.
 */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial', sql: INITIAL_SCHEMA },
  {
    version: 2,
    name: 'rentals',
    sql: `
      -- A checkout now buys either a plan or a 48-hour rental of one title.
      ALTER TABLE checkout_sessions
        ADD COLUMN kind TEXT NOT NULL DEFAULT 'subscription' CHECK (kind IN ('subscription', 'rental'));
      ALTER TABLE checkout_sessions ADD COLUMN movie_id TEXT;
      ALTER TABLE checkout_sessions ADD COLUMN item_title TEXT;
      ALTER TABLE checkout_sessions ALTER COLUMN plan_id DROP NOT NULL;
      ALTER TABLE checkout_sessions ADD CONSTRAINT checkout_sessions_item CHECK (
        (kind = 'subscription' AND plan_id IS NOT NULL) OR (kind = 'rental' AND movie_id IS NOT NULL)
      );

      CREATE TABLE rentals (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL REFERENCES users(id),
        movie_id            TEXT NOT NULL,
        title               TEXT NOT NULL,
        checkout_session_id TEXT NOT NULL UNIQUE REFERENCES checkout_sessions(id),
        amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),
        currency            CHAR(3) NOT NULL,
        starts_at           TIMESTAMPTZ NOT NULL,
        expires_at          TIMESTAMPTZ NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX rentals_user_expiry ON rentals (user_id, expires_at);
    `,
  },
];

export async function migrate(db: Db, options: { upTo?: number } = {}): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INT PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  const { rows } = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    if (options.upTo !== undefined && migration.version > options.upTo) break;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
        migration.version,
        migration.name,
      ]);
    });
  }
}
