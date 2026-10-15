import Stripe from 'stripe';

import { StripeProvider } from '../src/providers/stripe/stripe-provider.js';

export const STRIPE_WEBHOOK_SECRET = 'whsec_stripe_test';

interface FakeSession {
  id: string;
  object: 'checkout.session';
  url: string;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid';
  amount_total: number;
  currency: string;
  payment_intent: string | null;
  customer: string | null;
  client_reference_id: string | null;
  customer_creation: string | null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Plays Stripe's API over the SDK's fetch hook: it records what we send and
 * answers the calls the adapter makes. No network, no Stripe account.
 */
export class FakeStripeApi {
  readonly sessions = new Map<string, FakeSession>();
  readonly created: { params: URLSearchParams; idempotencyKey: string | null }[] = [];
  readonly charges: { params: URLSearchParams; idempotencyKey: string | null }[] = [];
  /** Set to make off-session charges decline like an empty card. */
  declineCharges = false;
  private readonly byIdempotencyKey = new Map<string, string>();

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const params = new URLSearchParams(String(init?.body ?? ''));
    const key = headers.get('idempotency-key');

    if (init?.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      const existing = key && this.byIdempotencyKey.get(key);
      if (existing) return json(this.sessions.get(existing));
      this.created.push({ params, idempotencyKey: key });
      const id = `cs_test_${this.created.length}`;
      const session: FakeSession = {
        id,
        object: 'checkout.session',
        url: `https://checkout.stripe.com/c/pay/${id}`,
        status: 'open',
        payment_status: 'unpaid',
        amount_total: Number(params.get('line_items[0][price_data][unit_amount]')),
        currency: params.get('line_items[0][price_data][currency]') ?? '',
        payment_intent: null,
        customer: null,
        client_reference_id: params.get('client_reference_id'),
        customer_creation: params.get('customer_creation'),
      };
      this.sessions.set(id, session);
      if (key) this.byIdempotencyKey.set(key, id);
      return json(session);
    }
    if (init?.method === 'GET' && url.pathname.startsWith('/v1/checkout/sessions/')) {
      const session = this.sessions.get(url.pathname.split('/').pop()!);
      return session ? json(session) : json({ error: { message: 'not found' } }, 404);
    }
    if (init?.method === 'GET' && url.pathname === '/v1/payment_methods') {
      return json({
        object: 'list',
        data: [{ id: `pm_for_${url.searchParams.get('customer')}`, object: 'payment_method' }],
        has_more: false,
      });
    }
    if (init?.method === 'POST' && url.pathname === '/v1/payment_intents') {
      this.charges.push({ params, idempotencyKey: key });
      if (this.declineCharges) {
        return json(
          {
            error: {
              type: 'card_error',
              code: 'card_declined',
              decline_code: 'insufficient_funds',
              message: 'Your card has insufficient funds.',
            },
          },
          402,
        );
      }
      return json({ id: `pi_off_${this.charges.length}`, object: 'payment_intent', status: 'succeeded' });
    }
    return json({ error: { message: `fake Stripe has no ${init?.method} ${url.pathname}` } }, 404);
  };

  /** The customer pays on Stripe's page. Saving the card creates a customer. */
  pay(id: string) {
    const session = this.sessions.get(id)!;
    Object.assign(session, {
      status: 'complete',
      payment_status: 'paid',
      payment_intent: `pi_${id}`,
      customer: session.customer_creation === 'always' ? `cus_${id}` : null,
    });
  }

  provider() {
    return new StripeProvider({
      secretKey: 'sk_test_fake',
      webhookSecret: STRIPE_WEBHOOK_SECRET,
      httpClient: Stripe.createFetchHttpClient(this.fetch),
    });
  }
}

const signer = new Stripe('sk_test_signer');

/** A Stripe event about a fake session, as JSON plus the header Stripe would sign it with. */
export function signedStripeEvent(type: string, session: unknown, eventId: string, secret = STRIPE_WEBHOOK_SECRET) {
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object: session },
  });
  return { payload, signature: signer.webhooks.generateTestHeaderString({ payload, secret }) };
}
