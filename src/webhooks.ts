import type { IncomingHttpHeaders } from 'node:http';

import type { Db, Queryable } from './db/index.js';
import { HttpError } from './lib/errors.js';
import { newId } from './lib/ids.js';
import {
  type NormalizedEvent,
  type ProviderId,
  type ProviderRegistry,
  WebhookSignatureError,
} from './providers/types.js';

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored';

/**
 * The provider's word is the source of truth for whether money moved. Each
 * event is recorded and applied in one transaction: a redelivered event hits
 * the primary key and changes nothing, and a failure part-way rolls back so
 * the provider's retry can apply it cleanly.
 */
export async function handleWebhook(
  deps: { db: Db; providers: ProviderRegistry },
  providerId: string,
  rawBody: Buffer,
  headers: IncomingHttpHeaders,
): Promise<WebhookOutcome> {
  const provider = deps.providers.get(providerId as ProviderId);
  if (!provider) throw new HttpError(404, 'not_found', `Unknown provider "${providerId}"`);

  let event: NormalizedEvent;
  try {
    event = provider.parseWebhook(rawBody, headers);
  } catch (err) {
    if (err instanceof WebhookSignatureError || err instanceof SyntaxError) {
      throw new HttpError(400, 'invalid_webhook', err.message);
    }
    throw err;
  }

  return deps.db.transaction(async (tx) => {
    const recorded = await tx.query(
      `INSERT INTO webhook_events (provider, event_id, type, payload) VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, event_id) DO NOTHING`,
      [provider.id, event.id, event.type, rawBody.toString('utf8')],
    );
    if (recorded.rowCount === 0) return 'duplicate';

    const note = await applyEvent(tx, provider.id, event);
    await tx.query(
      `UPDATE webhook_events SET processed_at = now(), note = $3 WHERE provider = $1 AND event_id = $2`,
      [provider.id, event.id, note],
    );
    return event.type === 'ignored' ? 'ignored' : 'processed';
  });
}

interface SessionRow {
  id: string;
  user_id: string;
  plan_id: string;
  amount_minor: number;
  currency: string;
  status: 'open' | 'paid' | 'failed';
}

/** Applies one event. Returns a short note stored beside the event for debugging. */
async function applyEvent(tx: Queryable, provider: ProviderId, event: NormalizedEvent): Promise<string> {
  if (event.type === 'ignored') return `ignored provider event type ${event.providerType}`;

  const { rows } = await tx.query<SessionRow>(
    `SELECT id, user_id, plan_id, amount_minor, currency, status FROM checkout_sessions
     WHERE provider = $1 AND provider_session_id = $2
     FOR UPDATE`,
    [provider, event.providerSessionId],
  );
  const session = rows[0];
  // Acknowledge rather than fail: retrying will never make an unknown session appear.
  if (!session) return `no checkout session for provider session ${event.providerSessionId}`;

  // Sessions only move forward from `open`. A late or out-of-order event
  // (a failure arriving after the payment) changes nothing.
  if (session.status !== 'open') return `session already ${session.status}`;

  if (event.type === 'checkout.failed') {
    await tx.query(
      `UPDATE checkout_sessions SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`,
      [session.id, event.reason],
    );
    return `session failed: ${event.reason}`;
  }

  // Never grant access for a different amount than we asked for.
  if (Number(event.amountMinor) !== Number(session.amount_minor) || event.currency !== session.currency) {
    await tx.query(
      `UPDATE checkout_sessions SET status = 'failed', failure_reason = 'amount_mismatch', updated_at = now()
       WHERE id = $1`,
      [session.id],
    );
    return `amount mismatch: expected ${session.amount_minor} ${session.currency}, got ${event.amountMinor} ${event.currency}`;
  }

  await tx.query(`UPDATE checkout_sessions SET status = 'paid', updated_at = now() WHERE id = $1`, [session.id]);
  await tx.query(
    `INSERT INTO payments
       (id, user_id, checkout_session_id, amount_minor, currency, provider, provider_payment_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'succeeded')`,
    [newId('pay'), session.user_id, session.id, session.amount_minor, session.currency, provider, event.providerPaymentId],
  );
  // Start (or switch to) the paid plan for one month from now, at the price paid.
  await tx.query(
    `INSERT INTO subscriptions
       (id, user_id, plan_id, status, amount_minor, currency, current_period_start, current_period_end)
     VALUES ($1, $2, $3, 'active', $4, $5, now(), now() + interval '1 month')
     ON CONFLICT (user_id) DO UPDATE SET
       plan_id = EXCLUDED.plan_id, status = 'active',
       amount_minor = EXCLUDED.amount_minor, currency = EXCLUDED.currency,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end = EXCLUDED.current_period_end, updated_at = now()`,
    [newId('sub'), session.user_id, session.plan_id, session.amount_minor, session.currency],
  );
  return `session paid, ${session.plan_id} subscription active`;
}
