import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { FakeStripeApi, STRIPE_WEBHOOK_SECRET, signedStripeEvent } from './fake-stripe.js';
import { PUBLIC_BASE_URL, createTestContext } from './helpers.js';

const fakeApi = new FakeStripeApi();
let ctx: Awaited<ReturnType<typeof createTestContext>>;

beforeAll(async () => {
  ctx = await createTestContext({ providers: [fakeApi.provider()] });
});

/** Sends a Stripe event about one of the fake sessions, signed like Stripe does. */
const sendStripeEvent = (type: string, sessionId: string, eventId = `evt_${Math.random()}`, secret = STRIPE_WEBHOOK_SECRET) => {
  const { payload, signature } = signedStripeEvent(type, fakeApi.sessions.get(sessionId), eventId, secret);
  return request(ctx.app)
    .post('/v1/webhooks/stripe')
    .set('content-type', 'application/json')
    .set('stripe-signature', signature)
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
