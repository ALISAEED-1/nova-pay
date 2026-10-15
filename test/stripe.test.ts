import Stripe from 'stripe';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { StripeProvider } from '../src/providers/stripe/stripe-provider.js';
import { PUBLIC_BASE_URL, createTestContext } from './helpers.js';

const STRIPE_WEBHOOK_SECRET = 'whsec_stripe_test';

interface FakeSession {
  id: string;
  object: 'checkout.session';
  url: string;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid';
  amount_total: number;
  currency: string;
  payment_intent: string | null;
  client_reference_id: string | null;
}

/**
 * Plays Stripe's API over the SDK's fetch hook: it records what we send and
 * answers the two calls the adapter makes. No network, no Stripe account.
 */
class FakeStripeApi {
  readonly sessions = new Map<string, FakeSession>();
  readonly created: { params: URLSearchParams; idempotencyKey: string | null }[] = [];
  private readonly byIdempotencyKey = new Map<string, string>();

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    let body: unknown;

    if (init?.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      const params = new URLSearchParams(String(init.body ?? ''));
      const key = headers.get('idempotency-key');
      const existing = key && this.byIdempotencyKey.get(key);
      if (existing) {
        body = this.sessions.get(existing);
      } else {
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
          client_reference_id: params.get('client_reference_id'),
        };
        this.sessions.set(id, session);
        if (key) this.byIdempotencyKey.set(key, id);
        body = session;
      }
    } else if (init?.method === 'GET' && url.pathname.startsWith('/v1/checkout/sessions/')) {
      body = this.sessions.get(url.pathname.split('/').pop()!);
    }

    return body
      ? new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
  };

  /** The customer pays on Stripe's page. */
  pay(id: string) {
    Object.assign(this.sessions.get(id)!, {
      status: 'complete',
      payment_status: 'paid',
      payment_intent: `pi_${id}`,
    });
  }
}

const fakeApi = new FakeStripeApi();
const signer = new Stripe('sk_test_signer');
let ctx: Awaited<ReturnType<typeof createTestContext>>;

beforeAll(async () => {
  ctx = await createTestContext({
    providers: [
      new StripeProvider({
        secretKey: 'sk_test_fake',
        webhookSecret: STRIPE_WEBHOOK_SECRET,
        httpClient: Stripe.createFetchHttpClient(fakeApi.fetch),
      }),
    ],
  });
});

/** Sends a Stripe event about one of the fake sessions, signed like Stripe does. */
const sendStripeEvent = (type: string, sessionId: string, eventId = `evt_${Math.random()}`, secret = STRIPE_WEBHOOK_SECRET) => {
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object: fakeApi.sessions.get(sessionId) },
  });
  return request(ctx.app)
    .post('/v1/webhooks/stripe')
    .set('content-type', 'application/json')
    .set('stripe-signature', signer.webhooks.generateTestHeaderString({ payload, secret }))
    .send(payload);
};

const providerSessionOf = async (sessionId: string) =>
  (
    await ctx.db.query<{ provider_session_id: string }>(
      'SELECT provider_session_id FROM checkout_sessions WHERE id = $1',
      [sessionId],
    )
  ).rows[0]!.provider_session_id;

const paymentCount = async () =>
  Number((await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM payments')).rows[0]!.n);

describe('Stripe checkout', () => {
  it('sends US and EU customers to Stripe with our price', async () => {
    const user = await ctx.register('DE');
    const created = await ctx.startCheckout(user.token, 'premium');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ provider: 'stripe', amount: { amountMinor: 1799, currency: 'EUR' } });
    expect(created.body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);

    const { params, idempotencyKey } = fakeApi.created.at(-1)!;
    expect(params.get('mode')).toBe('payment');
    expect(params.get('line_items[0][price_data][unit_amount]')).toBe('1799');
    expect(params.get('line_items[0][price_data][currency]')).toBe('eur');
    expect(params.get('client_reference_id')).toBe(created.body.id);
    expect(params.get('success_url')).toBe(created.body.returnUrl);
    expect(params.get('cancel_url')).toBe(`${created.body.returnUrl}&canceled=1`);
    // Subscriptions keep the card for renewals.
    expect(params.get('payment_intent_data[setup_future_usage]')).toBe('off_session');
    expect(idempotencyKey).toBe(`checkout-${created.body.id}`);
  });

  it('keeps Pakistan on the local provider', async () => {
    const user = await ctx.register('PK');
    const created = await ctx.startCheckout(user.token, 'basic');
    expect(created.body.provider).toBe('mock');
    expect(created.body.checkoutUrl).toMatch(`${PUBLIC_BASE_URL}/mock-provider/`);
  });

  it('activates the plan from a signed checkout.session.completed webhook, once', async () => {
    const user = await ctx.register('US');
    const created = await ctx.startCheckout(user.token, 'standard');
    const stripeSession = await providerSessionOf(created.body.id);
    fakeApi.pay(stripeSession);
    const before = await paymentCount();

    const first = await sendStripeEvent('checkout.session.completed', stripeSession, 'evt_completed_1');
    expect(first.body.outcome).toBe('processed');
    const again = await sendStripeEvent('checkout.session.completed', stripeSession, 'evt_completed_1');
    expect(again.body.outcome).toBe('duplicate');

    expect(await paymentCount()).toBe(before + 1);
    const me = await ctx.get('/v1/me', user.token);
    expect(me.body.subscription).toMatchObject({
      planId: 'standard',
      status: 'active',
      price: { amountMinor: 1499, currency: 'USD' },
    });
  });

  it('rejects a Stripe webhook with a bad signature', async () => {
    const user = await ctx.register('US');
    const created = await ctx.startCheckout(user.token, 'basic');
    const stripeSession = await providerSessionOf(created.body.id);
    fakeApi.pay(stripeSession);

    const forged = await sendStripeEvent('checkout.session.completed', stripeSession, 'evt_forged', 'whsec_wrong');
    expect(forged.status).toBe(400);
    const row = await ctx.db.query<{ status: string }>('SELECT status FROM checkout_sessions WHERE id = $1', [
      created.body.id,
    ]);
    expect(row.rows[0]!.status).toBe('open');
  });

  it('waits for the money when a completed session is still unpaid', async () => {
    const user = await ctx.register('US');
    const created = await ctx.startCheckout(user.token, 'basic');
    const stripeSession = await providerSessionOf(created.body.id);

    const completed = await sendStripeEvent('checkout.session.completed', stripeSession);
    expect(completed.body.outcome).toBe('ignored');

    fakeApi.pay(stripeSession);
    const settled = await sendStripeEvent('checkout.session.async_payment_succeeded', stripeSession);
    expect(settled.body.outcome).toBe('processed');
    expect((await ctx.get('/v1/me', user.token)).body.subscription.planId).toBe('basic');
  });

  it('confirms a payment by asking Stripe when no webhook has arrived', async () => {
    const user = await ctx.register('US');
    const created = await ctx.startCheckout(user.token, 'premium');
    const stripeSession = await providerSessionOf(created.body.id);

    const stillOpen = await ctx.get(`/v1/checkout/sessions/${created.body.id}`, user.token);
    expect(stillOpen.body.status).toBe('open');

    fakeApi.pay(stripeSession);
    const before = await paymentCount();
    const paid = await ctx.get(`/v1/checkout/sessions/${created.body.id}`, user.token);
    expect(paid.body.status).toBe('paid');
    expect((await ctx.get('/v1/me', user.token)).body.subscription.planId).toBe('premium');

    // The webhook turning up afterwards changes nothing.
    await sendStripeEvent('checkout.session.completed', stripeSession);
    expect(await paymentCount()).toBe(before + 1);
  });

  it('marks an expired Stripe session failed', async () => {
    const user = await ctx.register('US');
    const created = await ctx.startCheckout(user.token, 'basic');
    await sendStripeEvent('checkout.session.expired', await providerSessionOf(created.body.id));
    const session = await ctx.get(`/v1/checkout/sessions/${created.body.id}`, user.token);
    expect(session.body).toMatchObject({ status: 'failed', failureReason: 'expired' });
  });

  it('rents through Stripe without saving the card', async () => {
    const user = await ctx.register('FR');
    const created = await ctx.startRental(user.token, 'dune', 'Dune');
    expect(created.body).toMatchObject({ provider: 'stripe', amount: { amountMinor: 349, currency: 'EUR' } });
    const { params } = fakeApi.created.at(-1)!;
    expect(params.get('payment_intent_data[setup_future_usage]')).toBeNull();
    expect(params.get('line_items[0][price_data][product_data][name]')).toBe('Rent "Dune" for 48 hours');

    const stripeSession = await providerSessionOf(created.body.id);
    fakeApi.pay(stripeSession);
    await sendStripeEvent('checkout.session.completed', stripeSession);
    expect((await ctx.get('/v1/me', user.token)).body.rentals[0]).toMatchObject({ movieId: 'dune' });
  });
});

describe('Stripe configuration', () => {
  it('refuses a live secret key', () => {
    expect(() => loadConfig({ STRIPE_SECRET_KEY: 'sk_live_123' })).toThrow(/test-mode/);
    expect(loadConfig({ STRIPE_SECRET_KEY: 'sk_test_123' }).stripeSecretKey).toBe('sk_test_123');
  });
});
