import { findUser, getAccount, hasActivePlan } from './accounts.js';
import type { Db } from './db/index.js';
import { HttpError, notFound } from './lib/errors.js';
import { newId } from './lib/ids.js';
import { type Currency, type Money, money } from './lib/money.js';
import { findPlan } from './plans.js';
import type { ProviderId, ProviderRegistry } from './providers/types.js';
import { pickProvider, regionFor } from './regions.js';
import { RENTAL_HOURS, rentalOffer } from './rentals.js';
import { applyProviderEvent } from './webhooks.js';

export interface CheckoutDeps {
  db: Db;
  providers: ProviderRegistry;
  publicBaseUrl: string;
}

/** What a checkout buys. */
export type CheckoutItem =
  | { kind: 'subscription'; planId: string }
  | { kind: 'rental'; movieId: string; title: string };

export interface CheckoutSessionView {
  id: string;
  kind: 'subscription' | 'rental';
  status: 'open' | 'paid' | 'failed';
  planId: string | null;
  movieId: string | null;
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
  kind: 'subscription' | 'rental';
  plan_id: string | null;
  movie_id: string | null;
  item_title: string | null;
  amount_minor: number;
  currency: Currency;
  provider: ProviderId;
  provider_session_id: string | null;
  checkout_url: string | null;
  status: 'open' | 'paid' | 'failed';
  failure_reason: string | null;
}

export const returnUrlFor = (publicBaseUrl: string, sessionId: string) =>
  `${publicBaseUrl}/checkout/return?session=${encodeURIComponent(sessionId)}`;

const toView = (row: SessionRow, publicBaseUrl: string): CheckoutSessionView => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  planId: row.plan_id,
  movieId: row.movie_id,
  amount: money(Number(row.amount_minor), row.currency),
  provider: row.provider,
  checkoutUrl: row.checkout_url,
  returnUrl: returnUrlFor(publicBaseUrl, row.id),
  failureReason: row.failure_reason,
});

/**
 * Starts paying for a plan or a rental. The price comes from our own price
 * book in the customer's currency, never from the client. The same idempotency
 * key always returns the same session, so a double tap or a retried request
 * cannot create two charges.
 */
export async function createCheckoutSession(
  deps: CheckoutDeps,
  input: { userId: string; item: CheckoutItem; idempotencyKey: string },
): Promise<CheckoutSessionView> {
  const { db, providers, publicBaseUrl } = deps;
  const user = await findUser(db, input.userId);
  const region = regionFor(user.country);
  const priced = await priceItem(deps, input.userId, input.item, region.currency);

  await db.query(
    `INSERT INTO checkout_sessions
       (id, user_id, kind, plan_id, movie_id, item_title, amount_minor, currency, provider, status, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10)
     ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
    [
      newId('cs'),
      user.id,
      input.item.kind,
      priced.planId,
      priced.movieId,
      priced.title,
      priced.price.amountMinor,
      priced.price.currency,
      pickProvider(region, providers).id,
      input.idempotencyKey,
    ],
  );
  const { rows } = await db.query<SessionRow>(
    'SELECT * FROM checkout_sessions WHERE user_id = $1 AND idempotency_key = $2',
    [user.id, input.idempotencyKey],
  );
  const session = rows[0]!;
  if (
    session.kind !== input.item.kind ||
    session.plan_id !== priced.planId ||
    session.movie_id !== priced.movieId ||
    Number(session.amount_minor) !== priced.price.amountMinor
  ) {
    throw new HttpError(409, 'idempotency_key_reused', 'This idempotency key was already used for a different checkout');
  }
  if (session.checkout_url) return toView(session, publicBaseUrl);

  // First attempt, or a retry after the provider call failed: the provider is
  // idempotent on our session id, so calling it again is safe.
  const provider = providers.get(session.provider);
  if (!provider) throw new HttpError(503, 'provider_unavailable', `Provider "${session.provider}" is not set up`);
  let checkout;
  try {
    checkout = await provider.createCheckout(
      {
        reference: session.id,
        amountMinor: Number(session.amount_minor),
        currency: session.currency,
        description: priced.description,
        customerEmail: user.email,
        returnUrl: returnUrlFor(publicBaseUrl, session.id),
        savePaymentMethod: session.kind === 'subscription',
      },
      session.id,
    );
  } catch (err) {
    console.error(`${provider.id} createCheckout failed:`, (err as Error).message);
    throw new HttpError(502, 'provider_error', 'The payment provider is not responding. Try again.');
  }

  const updated = await db.query<SessionRow>(
    `UPDATE checkout_sessions SET provider_session_id = $2, checkout_url = $3, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [session.id, checkout.providerSessionId, checkout.url],
  );
  return toView(updated.rows[0]!, publicBaseUrl);
}

interface PricedItem {
  planId: string | null;
  movieId: string | null;
  title: string | null;
  description: string;
  price: Money;
}

async function priceItem(
  deps: CheckoutDeps,
  userId: string,
  item: CheckoutItem,
  currency: Currency,
): Promise<PricedItem> {
  if (item.kind === 'subscription') {
    const plan = await findPlan(deps.db, item.planId, currency);
    if (!plan) throw new HttpError(404, 'plan_not_found', `No plan "${item.planId}" in ${currency}`);
    return { planId: plan.id, movieId: null, title: null, description: `${plan.name} plan, monthly`, price: plan.price };
  }

  // Renting makes no sense for something the user can already watch.
  const account = await getAccount(deps.db, userId);
  if (hasActivePlan(account)) {
    throw new HttpError(409, 'covered_by_plan', 'Your plan already includes this title.');
  }
  if (account.rentals.some((r) => r.movieId === item.movieId)) {
    throw new HttpError(409, 'already_rented', 'You are already renting this title.');
  }
  return {
    planId: null,
    movieId: item.movieId,
    title: item.title,
    description: `Rent "${item.title}" for ${RENTAL_HOURS} hours`,
    price: rentalOffer(currency).price,
  };
}

/**
 * The session as the app sees it. While a session is still open and its
 * provider can be asked directly, ask: a webhook that is slow or never arrives
 * (no forwarding set up in development) must not leave a paid customer locked out.
 */
export async function getCheckoutSession(
  deps: CheckoutDeps,
  userId: string,
  sessionId: string,
): Promise<CheckoutSessionView> {
  const load = async () => {
    const { rows } = await deps.db.query<SessionRow>(
      'SELECT * FROM checkout_sessions WHERE id = $1 AND user_id = $2',
      [sessionId, userId],
    );
    if (!rows[0]) throw notFound('Checkout session');
    return rows[0];
  };

  let session = await load();
  const provider = deps.providers.get(session.provider);
  if (session.status === 'open' && session.provider_session_id && provider?.fetchCheckoutOutcome) {
    try {
      const outcome = await provider.fetchCheckoutOutcome(session.provider_session_id);
      if (outcome) {
        await applyProviderEvent(deps.db, provider.id, outcome, JSON.stringify({ source: 'status_check', ...outcome }));
        session = await load();
      }
    } catch (err) {
      console.warn(`${provider.id} status check failed:`, (err as Error).message);
    }
  }
  return toView(session, deps.publicBaseUrl);
}
