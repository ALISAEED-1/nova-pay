import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import { Router } from 'express';

import type { Db } from '../../db/index.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { isCurrency } from '../../lib/money.js';
import {
  type CreateCheckoutInput,
  type NormalizedEvent,
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
}

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
 * and Cancel buttons, and sends HMAC-signed webhooks, so the rest of the system
 * runs exactly as it will against Stripe or JazzCash, without real money.
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
         (id, reference, amount_minor, currency, description, customer, return_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
       ON CONFLICT (reference) DO NOTHING`,
      [
        newId('mps'),
        idempotencyKey,
        input.amountMinor,
        input.currency,
        input.description,
        input.customerEmail,
        input.returnUrl,
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
        }),
      );
    });

    router.post('/checkout/:id/:action', async (req, res) => {
      const action = req.params.action;
      const next = { pay: 'succeeded', decline: 'failed', cancel: 'canceled' }[action];
      if (!next) throw new HttpError(404, 'not_found', `unknown action ${action}`);

      // Only an open session can move. A double-tapped Pay button finds it
      // already succeeded and sends no second webhook.
      const { rows } = await this.options.db.query<MockSessionRow>(
        `UPDATE mock_provider_sessions SET status = $2 WHERE id = $1 AND status = 'open' RETURNING *`,
        [req.params.id, next],
      );
      const moved = rows[0];
      if (moved && moved.status !== 'canceled') this.emit(moved);

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

  private emit(session: MockSessionRow) {
    const succeeded = session.status === 'succeeded';
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
