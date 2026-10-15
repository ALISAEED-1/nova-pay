import type { Queryable } from './db/index.js';
import { HttpError, notFound } from './lib/errors.js';
import { newId } from './lib/ids.js';
import { type Currency, type Money, money } from './lib/money.js';
import { regionFor } from './regions.js';
import { type RentalView, activeRentals } from './rentals.js';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  country: string;
}

export interface SubscriptionView {
  id: string;
  planId: string;
  planName: string;
  quality: string;
  /** `expired` is derived: the period ended and nothing renewed it (renewals arrive in Phase 4). */
  status: 'active' | 'past_due' | 'canceled' | 'expired';
  price: Money;
  currentPeriodStart: string;
  currentPeriodEnd: string;
}

export interface AccountView {
  user: { id: string; name: string; email: string; country: string; currency: Currency };
  subscription: SubscriptionView | null;
  /** Titles rented and still within their watch window. */
  rentals: RentalView[];
}

interface SubscriptionRow {
  id: string;
  plan_id: string;
  plan_name: string;
  quality: string;
  status: 'active' | 'past_due' | 'canceled';
  amount_minor: number;
  currency: Currency;
  current_period_start: Date;
  current_period_end: Date;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function createUser(
  db: Queryable,
  input: { name: string; email: string; passwordHash: string; country: string },
): Promise<UserRow> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (id, email, name, password_hash, country) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO NOTHING
     RETURNING *`,
    [newId('usr'), normalizeEmail(input.email), input.name.trim(), input.passwordHash, input.country.toUpperCase()],
  );
  if (!rows[0]) throw new HttpError(409, 'email_taken', 'An account with this email already exists.');
  return rows[0];
}

export async function findUserByEmail(db: Queryable, email: string): Promise<UserRow | undefined> {
  const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE email = $1', [normalizeEmail(email)]);
  return rows[0];
}

export async function findUser(db: Queryable, userId: string): Promise<UserRow> {
  const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  if (!rows[0]) throw notFound('Account');
  return rows[0];
}

export async function updateUser(
  db: Queryable,
  userId: string,
  changes: { name?: string; country?: string },
): Promise<void> {
  await db.query(
    `UPDATE users SET name = COALESCE($2, name), country = COALESCE($3, country), updated_at = now()
     WHERE id = $1`,
    [userId, changes.name?.trim() ?? null, changes.country?.toUpperCase() ?? null],
  );
}

/** Everything the app needs about the signed-in user, including what they may watch. */
export async function getAccount(db: Queryable, userId: string): Promise<AccountView> {
  const user = await findUser(db, userId);
  const { rows } = await db.query<SubscriptionRow>(
    `SELECT s.id, s.plan_id, p.name AS plan_name, p.quality, s.status, s.amount_minor, s.currency,
            s.current_period_start, s.current_period_end
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = $1`,
    [userId],
  );
  const sub = rows[0];
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      country: user.country,
      currency: regionFor(user.country).currency,
    },
    subscription: sub
      ? {
          id: sub.id,
          planId: sub.plan_id,
          planName: sub.plan_name,
          quality: sub.quality,
          status:
            sub.status === 'active' && sub.current_period_end.getTime() <= Date.now() ? 'expired' : sub.status,
          price: money(Number(sub.amount_minor), sub.currency),
          currentPeriodStart: sub.current_period_start.toISOString(),
          currentPeriodEnd: sub.current_period_end.toISOString(),
        }
      : null,
    rentals: await activeRentals(db, userId),
  };
}

/** True while the user's subscription lets them watch everything. */
export const hasActivePlan = (account: AccountView) => account.subscription?.status === 'active';
