import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import { Router } from 'express';

import type { Db } from '../../db/index.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { isCurrency } from '../../lib/money.js';
import {
  type ChargeResult,
  type CreateCheckoutInput,
  type NormalizedEvent,
  type OffSessionCharge,
  type PaymentProvider,
  type ProviderCheckout,
  WebhookSignatureError,
} from '../types.js';
import { checkoutPage } from './pages.js';

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';
const SIGNATURE_TOLERANCE_SECONDS = 300;
const RETRY_DELAYS_MS = [0, 1_000, 5_000];

/** Sends a signed webhook to our own endpoint, the way a real provider would. */
export type WebhookDeliverer = (body: string, headers: Record<string, string>) => Promise<void>;

interface MockSessionRow {
  id: string;
  reference: string;
  amount_minor: number;
  currency: string;
  description: string;
  customer: string;
  return_url: string;
  status: 'open' | 'succeeded' | 'failed' | 'canceled';
  save_payment_method: boolean;
}

/**
 * The ways to pay on the hosted page. The two cards are saved for renewals
 * (one is set up to decline then, for testing dunning); a mobile wallet, like
 * JazzCash or Easypaisa, can't be charged later, so it renews by hand.
 */
const PAY_METHODS = {
  pay: { label: 'Visa •••• 4242', saved: 'succeeds' },
  'pay-failing-card': { label: 'Mastercard •••• 0341', saved: 'declines' },
  'pay-wallet': { label: 'Mobile wallet', saved: null },
} as const;
type PayAction = keyof typeof PAY_METHODS;

/** The provider's own webhook format, deliberately unlike our NormalizedEvent. */
interface MockEvent {
  id: string;
  type: 'payment.succeeded' | 'payment.failed';
  created: number;
  data: {
    object: {
      session: string;
      payment: string | null;
      reference: string;
      amount: number;
      currency: string;
      failure_code: string | null;
      customer: string;
      /** Saved method that can be charged later, if the checkout asked to save one. */
      payment_method: string | null;
      payment_method_label: string | null;
    };
  };
}

export function signMockPayload(
  body: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

/**
 * A stand-in payment provider. It has a hosted checkout page with Pay, Decline
 * and Cancel buttons, sends HMAC-signed webhooks, and charges saved cards for
 * renewals, so the rest of the system runs exactly as it will against Stripe
 * or JazzCash, without real money.
 */
export class MockProvider implements PaymentProvider {
  readonly id = 'mock' as const;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly options: {
      db: Db;
      publicBaseUrl: string;
      webhookSecret: string;
      deliver: WebhookDeliverer;
    },
  ) {}

  async createCheckout(input: CreateCheckoutInput, idempotencyKey: string): Promise<ProviderCheckout> {
    const { db, publicBaseUrl } = this.options;
    // The idempotency key is our session id, stored as `reference`: a retry
    // finds the existing row instead of creating a second checkout.
    await db.query(
      `INSERT INTO mock_provider_sessions
         (id, reference, amount_minor, currency, description, customer, return_url, status, save_payment_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8)
       ON CONFLICT (reference) DO NOTHING`,
      [
        newId('mps'),
        idempotencyKey,
        input.amountMinor,
        input.currency,
        input.description,
        input.customerEmail,
        input.returnUrl,
        input.savePaymentMethod,
      ],
    );
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM mock_provider_sessions WHERE reference = $1',
      [idempotencyKey],
    );
    const id = rows[0]!.id;
    return { providerSessionId: id, url: `${publicBaseUrl}/mock-provider/checkout/${id}` };
  }

  parseWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): NormalizedEvent {
    const header = headers[MOCK_SIGNATURE_HEADER];
    if (typeof header !== 'string') throw new WebhookSignatureError('missing signature header');

    const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
    const timestamp = Number(parts.t);
    if (!Number.isInteger(timestamp) || !parts.v1) {
      throw new WebhookSignatureError('malformed signature header');
    }
    if (Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
      throw new WebhookSignatureError('signature timestamp outside tolerance');
    }
    const expected = createHmac('sha256', this.options.webhookSecret)
      .update(`${timestamp}.${rawBody.toString('utf8')}`)
      .digest();
    const given = Buffer.from(parts.v1, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new WebhookSignatureError('signature mismatch');
    }

    const event = JSON.parse(rawBody.toString('utf8')) as MockEvent;
    const object = event.data.object;
    switch (event.type) {
      case 'payment.succeeded':
        return {
          id: event.id,
          type: 'checkout.paid',
          providerSessionId: object.session,
          providerPaymentId: object.payment!,
          amountMinor: object.amount,
          currency: object.currency,
          ...(object.payment_method_label
            ? {
                savedPaymentMethod: {
                  customerRef: object.customer,
                  paymentMethodRef: object.payment_method,
                  label: object.payment_method_label,
                },
              }
            : {}),
        };
      case 'payment.failed':
        return {
          id: event.id,
          type: 'checkout.failed',
          providerSessionId: object.session,
          reason: object.failure_code ?? 'unknown',
        };
      default:
        return { id: event.id, type: 'ignored', providerType: String((event as { type: unknown }).type) };
    }
  }

  async chargeSavedPaymentMethod(input: OffSessionCharge, idempotencyKey: string): Promise<ChargeResult> {
    const { db } = this.options;
    const { rows: methods } = await db.query<{ id: string; behavior: 'succeeds' | 'declines' }>(
      'SELECT id, behavior FROM mock_payment_methods WHERE id = $1',
      [input.paymentMethodRef],
    );
    const method = methods[0];
    if (!method) return { status: 'failed', reason: 'payment_method_missing' };

    // Recorded under the idempotency key, so a retried call returns the first result.
    const declined = method.behavior === 'declines';
    await db.query(
      `INSERT INTO mock_charges (id, idempotency_key, payment_method_id, amount_minor, currency, status, failure_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        newId('mch'),
        idempotencyKey,
        method.id,
        input.amountMinor,
        input.currency,
        declined ? 'failed' : 'succeeded',
        declined ? 'insufficient_funds' : null,
      ],
    );
    const { rows } = await db.query<{ id: string; status: string; failure_code: string | null }>(
      'SELECT id, status, failure_code FROM mock_charges WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    const charge = rows[0]!;
    return charge.status === 'succeeded'
      ? { status: 'succeeded', providerPaymentId: charge.id }
      : { status: 'failed', reason: charge.failure_code ?? 'card_declined' };
  }

  /** Hosted checkout pages, mounted at /mock-provider. */
  router(): Router {
    const router = Router();

    router.get('/checkout/:id', async (req, res) => {
      const session = await this.findSession(req.params.id);
      res.type('html').send(
        checkoutPage({
          id: session.id,
          description: session.description,
          customer: session.customer,
          amountMinor: Number(session.amount_minor),
          currency: isCurrency(session.currency) ? session.currency : 'USD',
          status: session.status,
          savePaymentMethod: session.save_payment_method,
        }),
      );
    });

    router.post('/checkout/:id/:action', async (req, res) => {
      const action = req.params.action;
      const paying = action in PAY_METHODS;
      const next = paying ? 'succeeded' : { decline: 'failed', cancel: 'canceled' }[action];
      if (!next) throw new HttpError(404, 'not_found', `unknown action ${action}`);

      // Only an open session can move. A double-tapped Pay button finds it
      // already succeeded and sends no second webhook.
      const { rows } = await this.options.db.query<MockSessionRow>(
        `UPDATE mock_provider_sessions SET status = $2 WHERE id = $1 AND status = 'open' RETURNING *`,
        [req.params.id, next],
      );
      const moved = rows[0];
      if (moved && moved.status !== 'canceled') {
        await this.emit(moved, paying ? (action as PayAction) : null);
      }

      const session = moved ?? (await this.findSession(req.params.id));
      const url = new URL(session.return_url);
      if (session.status === 'canceled') url.searchParams.set('canceled', '1');
      res.redirect(303, url.toString());
    });

    return router;
  }

  /** Resolves once every webhook sent so far has been delivered or given up on. */
  async flush(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }

  private async emit(session: MockSessionRow, payAction: PayAction | null) {
    const succeeded = session.status === 'succeeded';

    // Keep the payment method when the checkout asked for it.
    let paymentMethod: string | null = null;
    let paymentMethodLabel: string | null = null;
    if (succeeded && payAction && session.save_payment_method) {
      const method = PAY_METHODS[payAction];
      paymentMethodLabel = method.label;
      if (method.saved) {
        paymentMethod = newId('mpm');
        await this.options.db.query(
          'INSERT INTO mock_payment_methods (id, customer, label, behavior) VALUES ($1, $2, $3, $4)',
          [paymentMethod, session.customer, method.label, method.saved],
        );
      }
    }

    const event: MockEvent = {
      id: newId('evt'),
      type: succeeded ? 'payment.succeeded' : 'payment.failed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          session: session.id,
          payment: succeeded ? newId('mpay') : null,
          reference: session.reference,
          amount: Number(session.amount_minor),
          currency: session.currency,
          failure_code: succeeded ? null : 'card_declined',
          customer: session.customer,
          payment_method: paymentMethod,
          payment_method_label: paymentMethodLabel,
        },
      },
    };
    const delivery = this.deliverWithRetry(JSON.stringify(event));
    this.inFlight.add(delivery);
    void delivery.finally(() => this.inFlight.delete(delivery));
  }

  private async deliverWithRetry(body: string): Promise<void> {
    for (const [attempt, delay] of RETRY_DELAYS_MS.entries()) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await this.options.deliver(body, {
          'content-type': 'application/json',
          [MOCK_SIGNATURE_HEADER]: signMockPayload(body, this.options.webhookSecret),
        });
        return;
      } catch (err) {
        console.warn(`mock webhook delivery attempt ${attempt + 1} failed:`, (err as Error).message);
      }
    }
    console.error('mock webhook delivery gave up after', RETRY_DELAYS_MS.length, 'attempts');
  }

  private async findSession(id: string): Promise<MockSessionRow> {
    const { rows } = await this.options.db.query<MockSessionRow>(
      'SELECT * FROM mock_provider_sessions WHERE id = $1',
      [id],
    );
    if (!rows[0]) throw notFound('Checkout');
    return rows[0];
  }
}
