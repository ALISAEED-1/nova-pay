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
  {
    version: 3,
    name: 'renewals',
    sql: `
      -- How a subscription renews, and where it is in its life.
      ALTER TABLE subscriptions
        ADD COLUMN cancel_at_period_end  BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN canceled_at           TIMESTAMPTZ,
        ADD COLUMN ended_reason          TEXT,
        ADD COLUMN grace_until           TIMESTAMPTZ,
        ADD COLUMN provider              TEXT,
        ADD COLUMN provider_customer_ref TEXT,
        ADD COLUMN payment_method_ref    TEXT,
        ADD COLUMN payment_method_label  TEXT;

      -- One invoice per subscription period. The unique key is what keeps the
      -- billing job from billing the same month twice.
      CREATE TABLE invoices (
        id              TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
        user_id         TEXT NOT NULL REFERENCES users(id),
        plan_id         TEXT NOT NULL REFERENCES plans(id),
        period_start    TIMESTAMPTZ NOT NULL,
        period_end      TIMESTAMPTZ NOT NULL,
        amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
        currency        CHAR(3) NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('open', 'paid', 'void', 'uncollectible')),
        collection      TEXT NOT NULL CHECK (collection IN ('automatic', 'manual')),
        attempt_count   INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        last_error      TEXT,
        paid_at         TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (subscription_id, period_start)
      );
      CREATE INDEX invoices_due ON invoices (status, next_attempt_at);

      -- What happened to a subscription and when: the messages a production
      -- system would email (renewal reminder, payment failed, plan ended).
      CREATE TABLE billing_events (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id),
        subscription_id TEXT REFERENCES subscriptions(id),
        type            TEXT NOT NULL,
        data            JSONB NOT NULL DEFAULT '{}',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX billing_events_user ON billing_events (user_id, created_at);

      -- A payment now settles a checkout, an invoice, or both (paying an
      -- overdue invoice through a checkout page).
      ALTER TABLE payments ALTER COLUMN checkout_session_id DROP NOT NULL;
      ALTER TABLE payments ADD COLUMN invoice_id TEXT UNIQUE REFERENCES invoices(id);
      ALTER TABLE payments ADD CONSTRAINT payments_source
        CHECK (checkout_session_id IS NOT NULL OR invoice_id IS NOT NULL);

      ALTER TABLE checkout_sessions ADD COLUMN invoice_id TEXT REFERENCES invoices(id);
      ALTER TABLE checkout_sessions DROP CONSTRAINT checkout_sessions_kind_check;
      ALTER TABLE checkout_sessions ADD CONSTRAINT checkout_sessions_kind_check
        CHECK (kind IN ('subscription', 'rental', 'renewal'));
      ALTER TABLE checkout_sessions DROP CONSTRAINT checkout_sessions_item;
      ALTER TABLE checkout_sessions ADD CONSTRAINT checkout_sessions_item CHECK (
        (kind = 'subscription' AND plan_id IS NOT NULL)
        OR (kind = 'rental' AND movie_id IS NOT NULL)
        OR (kind = 'renewal' AND plan_id IS NOT NULL AND invoice_id IS NOT NULL)
      );

      -- Mock provider: saved payment methods and off-session charges.
      ALTER TABLE mock_provider_sessions ADD COLUMN save_payment_method BOOLEAN NOT NULL DEFAULT false;
      CREATE TABLE mock_payment_methods (
        id         TEXT PRIMARY KEY,
        customer   TEXT NOT NULL,
        label      TEXT NOT NULL,
        behavior   TEXT NOT NULL CHECK (behavior IN ('succeeds', 'declines')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE mock_charges (
        id                TEXT PRIMARY KEY,
        idempotency_key   TEXT NOT NULL UNIQUE,
        payment_method_id TEXT NOT NULL REFERENCES mock_payment_methods(id),
        amount_minor      BIGINT NOT NULL,
        currency          CHAR(3) NOT NULL,
        status            TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
        failure_code      TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
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
