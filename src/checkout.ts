import { findUser } from './accounts.js';
import type { Db } from './db/index.js';
import { HttpError, notFound } from './lib/errors.js';
import { newId } from './lib/ids.js';
import { type Currency, type Money, money } from './lib/money.js';
import { findPlan } from './plans.js';
import type { ProviderId, ProviderRegistry } from './providers/types.js';
import { regionFor } from './regions.js';

export interface CheckoutDeps {
  db: Db;
  providers: ProviderRegistry;
  publicBaseUrl: string;
}

export interface CheckoutSessionView {
  id: string;
  status: 'open' | 'paid' | 'failed';
  planId: string;
  amount: Money;
  provider: string;
  /** Hosted payment page to open for the customer. */
  checkoutUrl: string | null;
  /** The provider sends the customer here when they are done; the app watches for it. */
  returnUrl: string;
  failureReason: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  plan_id: string;
  amount_minor: number;
  currency: Currency;
  provider: string;
  provider_session_id: string | null;
  checkout_url: string | null;
  status: 'open' | 'paid' | 'failed';
  failure_reason: string | null;
}

export const returnUrlFor = (publicBaseUrl: string, sessionId: string) =>
  `${publicBaseUrl}/checkout/return?session=${encodeURIComponent(sessionId)}`;

const toView = (row: SessionRow, publicBaseUrl: string): CheckoutSessionView => ({
  id: row.id,
  status: row.status,
  planId: row.plan_id,
  amount: money(Number(row.amount_minor), row.currency),
  provider: row.provider,
  checkoutUrl: row.checkout_url,
  returnUrl: returnUrlFor(publicBaseUrl, row.id),
  failureReason: row.failure_reason,
});

/**
 * Starts paying for a plan. The price comes from our price book in the
 * customer's currency, never from the client. The same idempotency key always
 * returns the same session, so a double tap or a retried request cannot
 * create two charges.
 */
export async function createCheckoutSession(
  deps: CheckoutDeps,
  input: { userId: string; planId: string; idempotencyKey: string },
): Promise<CheckoutSessionView> {
  const { db, providers, publicBaseUrl } = deps;
  const user = await findUser(db, input.userId);
  const region = regionFor(user.country);
  const plan = await findPlan(db, input.planId, region.currency);
  if (!plan) throw new HttpError(404, 'plan_not_found', `No plan "${input.planId}" in ${region.currency}`);

  await db.query(
    `INSERT INTO checkout_sessions
       (id, user_id, plan_id, amount_minor, currency, provider, status, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7)
     ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
    [newId('cs'), user.id, plan.id, plan.price.amountMinor, plan.price.currency, region.provider, input.idempotencyKey],
  );
  const { rows } = await db.query<SessionRow>(
    'SELECT * FROM checkout_sessions WHERE user_id = $1 AND idempotency_key = $2',
    [user.id, input.idempotencyKey],
  );
  const session = rows[0]!;
  if (session.plan_id !== plan.id || Number(session.amount_minor) !== plan.price.amountMinor) {
    throw new HttpError(409, 'idempotency_key_reused', 'This idempotency key was already used for a different checkout');
  }
  if (session.checkout_url) return toView(session, publicBaseUrl);

  // First attempt, or a retry after the provider call failed: the provider is
  // idempotent on our session id, so calling it again is safe.
  const provider = providers.get(session.provider as ProviderId);
  if (!provider) throw new HttpError(500, 'provider_unavailable', `No provider "${session.provider}"`);
  let checkout;
  try {
    checkout = await provider.createCheckout(
      {
        reference: session.id,
        amountMinor: Number(session.amount_minor),
        currency: session.currency,
        description: `${plan.name} plan, monthly`,
        customerEmail: user.email,
        returnUrl: returnUrlFor(publicBaseUrl, session.id),
      },
      session.id,
    );
  } catch (err) {
    console.error('provider createCheckout failed', err);
    throw new HttpError(502, 'provider_error', 'The payment provider is not responding. Try again.');
  }

  const updated = await db.query<SessionRow>(
    `UPDATE checkout_sessions SET provider_session_id = $2, checkout_url = $3, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [session.id, checkout.providerSessionId, checkout.url],
  );
  return toView(updated.rows[0]!, publicBaseUrl);
}

export async function getCheckoutSession(
  deps: Pick<CheckoutDeps, 'db' | 'publicBaseUrl'>,
  userId: string,
  sessionId: string,
): Promise<CheckoutSessionView> {
  const { rows } = await deps.db.query<SessionRow>(
    'SELECT * FROM checkout_sessions WHERE id = $1 AND user_id = $2',
    [sessionId, userId],
  );
  if (!rows[0]) throw notFound('Checkout session');
  return toView(rows[0], deps.publicBaseUrl);
}
