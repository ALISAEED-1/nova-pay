import { beforeAll, describe, expect, it } from 'vitest';

import { createTestContext } from './helpers.js';

let ctx: Awaited<ReturnType<typeof createTestContext>>;
beforeAll(async () => {
  ctx = await createTestContext();
});

/** Rents a title through the mock provider's hosted page. */
const rentAndPay = async (token: string, movieId: string, title: string) => {
  const created = await ctx.startRental(token, movieId, title);
  expect(created.status).toBe(201);
  await ctx.pressCheckoutButton(created.body.checkoutUrl, 'pay');
  await ctx.mockProvider.flush();
  return created.body;
};

describe('rentals', () => {
  it('offers a 48-hour rental in the account currency', async () => {
    const pk = await ctx.register('PK');
    const de = await ctx.register('DE');
    expect((await ctx.get('/v1/rentals/offer', pk.token)).body).toEqual({
      hours: 48,
      price: { amountMinor: 19900, currency: 'PKR', formatted: 'Rs 199' },
    });
    expect((await ctx.get('/v1/rentals/offer', de.token)).body.price.formatted).toBe('€3.49');
  });

  it('rents a title for 48 hours once the payment is confirmed', async () => {
    const user = await ctx.register('PK');
    const session = await rentAndPay(user.token, 'dune', 'Dune');
    expect(session).toMatchObject({
      kind: 'rental',
      movieId: 'dune',
      planId: null,
      amount: { amountMinor: 19900, currency: 'PKR' },
    });

    const me = await ctx.get('/v1/me', user.token);
    expect(me.body.subscription).toBeNull();
    expect(me.body.rentals).toHaveLength(1);
    expect(me.body.rentals[0]).toMatchObject({ movieId: 'dune', title: 'Dune' });
    const hours = (Date.parse(me.body.rentals[0].expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThanOrEqual(48);
  });

  it('refuses to rent a title that is already rented', async () => {
    const user = await ctx.register('US');
    await rentAndPay(user.token, 'the_batman', 'The Batman');
    const again = await ctx.startRental(user.token, 'the_batman', 'The Batman');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_rented');
  });

  it('refuses a rental when the plan already covers it', async () => {
    const user = await ctx.register('US');
    const plan = await ctx.startCheckout(user.token, 'basic');
    await ctx.pressCheckoutButton(plan.body.checkoutUrl, 'pay');
    await ctx.mockProvider.flush();

    const rental = await ctx.startRental(user.token, 'dune', 'Dune');
    expect(rental.status).toBe(409);
    expect(rental.body.error.code).toBe('covered_by_plan');
  });

  it('grants nothing for a declined rental', async () => {
    const user = await ctx.register('US');
    const created = await ctx.startRental(user.token, 'dune', 'Dune');
    await ctx.pressCheckoutButton(created.body.checkoutUrl, 'decline');
    await ctx.mockProvider.flush();
    expect((await ctx.get('/v1/me', user.token)).body.rentals).toEqual([]);
  });

  it('will not reuse an idempotency key across a plan and a rental', async () => {
    const user = await ctx.register('US');
    await ctx.startCheckout(user.token, 'basic', 'shared-key');
    const rental = await ctx.startRental(user.token, 'dune', 'Dune', 'shared-key');
    expect(rental.status).toBe(409);
  });

  it('validates the rental request', async () => {
    const user = await ctx.register('US');
    expect((await ctx.startRental(user.token, '../etc/passwd', 'x')).status).toBe(400);
    expect((await ctx.startRental(user.token, 'dune', '')).status).toBe(400);
  });
});
