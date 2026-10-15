import { describe, expect, it } from 'vitest';

import { openDb } from '../src/db/index.js';
import { MIGRATIONS, migrate } from '../src/db/migrations.js';
import { seedPlans } from '../src/db/seed.js';

describe('migrations', () => {
  it('upgrades a Phase 1 database without losing its checkouts', async () => {
    const db = await openDb({}, { upTo: 1 });
    await seedPlans(db);
    await db.query(
      `INSERT INTO users (id, email, name, password_hash, country) VALUES ('usr_1', 'a@example.com', 'A', 'x', 'US')`,
    );
    await db.query(
      `INSERT INTO checkout_sessions (id, user_id, plan_id, amount_minor, currency, provider, status, idempotency_key)
       VALUES ('cs_old', 'usr_1', 'basic', 999, 'USD', 'mock', 'paid', 'k1')`,
    );

    await migrate(db);

    const { rows } = await db.query<{ kind: string; plan_id: string }>(
      `SELECT kind, plan_id FROM checkout_sessions WHERE id = 'cs_old'`,
    );
    expect(rows[0]).toEqual({ kind: 'subscription', plan_id: 'basic' });
    const versions = await db.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
    expect(versions.rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));

    // A rental needs a title id; a subscription needs a plan.
    await expect(
      db.query(
        `INSERT INTO checkout_sessions (id, user_id, kind, amount_minor, currency, provider, status, idempotency_key)
         VALUES ('cs_bad', 'usr_1', 'rental', 399, 'USD', 'mock', 'open', 'k2')`,
      ),
    ).rejects.toThrow();
    await db.close();
  });

  it('runs each migration once', async () => {
    const db = await openDb({});
    await migrate(db);
    await migrate(db);
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations');
    expect(rows[0]!.n).toBe(MIGRATIONS.length);
    await db.close();
  });
});
