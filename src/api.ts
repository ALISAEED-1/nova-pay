import express, { Router } from 'express';
import { z } from 'zod';

import { createUser, findUser, findUserByEmail, getAccount, updateUser } from './accounts.js';
import { hashPassword, requireAuth, signToken, userIdOf, verifyPassword } from './auth/auth.js';
import { createCheckoutSession, getCheckoutSession } from './checkout.js';
import type { Db } from './db/index.js';
import { HttpError } from './lib/errors.js';
import { listPlans } from './plans.js';
import type { ProviderRegistry } from './providers/types.js';
import { FEATURED_COUNTRIES, regionFor } from './regions.js';
import { rentalOffer } from './rentals.js';
import { handleWebhook } from './webhooks.js';

export interface ApiDeps {
  db: Db;
  providers: ProviderRegistry;
  jwtSecret: string;
  publicBaseUrl: string;
}

const country = z
  .string()
  .regex(/^[A-Za-z]{2}$/, 'must be a two-letter country code')
  .transform((c) => c.toUpperCase());

const registerBody = z.object({
  name: z.string().trim().min(1).max(60),
  email: z.email(),
  password: z.string().min(6).max(200),
  country: country.default('US'),
});
const loginBody = z.object({ email: z.string().min(1), password: z.string().min(1) });
const updateMeBody = z.object({ name: z.string().trim().min(1).max(60).optional(), country: country.optional() });
/** `{planId}` buys a plan; `{movieId, title}` rents one title. */
const checkoutBody = z.union([
  z.object({ planId: z.string().min(1) }).transform((b) => ({ kind: 'subscription' as const, planId: b.planId })),
  z
    .object({
      movieId: z.string().regex(/^[a-z0-9_-]{1,64}$/, 'must be a catalogue id'),
      title: z.string().trim().min(1).max(120),
    })
    .transform((b) => ({ kind: 'rental' as const, movieId: b.movieId, title: b.title })),
]);

/** Everything under /v1. */
export function apiRouter(deps: ApiDeps): Router {
  const { db, jwtSecret } = deps;
  const router = Router();
  const auth = requireAuth(jwtSecret);

  // Webhooks need the exact bytes the provider signed, so they get the raw
  // body and are registered before the JSON parser.
  router.post('/webhooks/:provider', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const outcome = await handleWebhook(deps, req.params.provider, body, req.headers);
    res.json({ received: true, outcome });
  });

  router.use(express.json({ limit: '32kb' }));

  router.post('/auth/register', async (req, res) => {
    const body = registerBody.parse(req.body);
    const user = await createUser(db, { ...body, passwordHash: await hashPassword(body.password) });
    res.status(201).json({ token: signToken(user.id, jwtSecret), account: await getAccount(db, user.id) });
  });

  router.post('/auth/login', async (req, res) => {
    const body = loginBody.parse(req.body);
    const user = await findUserByEmail(db, body.email);
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      throw new HttpError(401, 'invalid_credentials', 'Invalid email or password.');
    }
    res.json({ token: signToken(user.id, jwtSecret), account: await getAccount(db, user.id) });
  });

  router.get('/me', auth, async (_req, res) => {
    res.json(await getAccount(db, userIdOf(res)));
  });

  router.patch('/me', auth, async (req, res) => {
    await updateUser(db, userIdOf(res), updateMeBody.parse(req.body));
    res.json(await getAccount(db, userIdOf(res)));
  });

  router.get('/regions', (_req, res) => {
    res.json({
      countries: FEATURED_COUNTRIES.map((c) => ({ ...c, currency: regionFor(c.country).currency })),
    });
  });

  router.get('/plans', auth, async (_req, res) => {
    const user = await findUser(db, userIdOf(res));
    const region = regionFor(user.country);
    res.json({
      country: user.country,
      currency: region.currency,
      plans: await listPlans(db, region.currency),
    });
  });

  router.get('/rentals/offer', auth, async (_req, res) => {
    const user = await findUser(db, userIdOf(res));
    res.json(rentalOffer(regionFor(user.country).currency));
  });

  router.post('/checkout/sessions', auth, async (req, res) => {
    const idempotencyKey = req.header('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.length > 100) {
      throw new HttpError(400, 'idempotency_key_required', 'Send an Idempotency-Key header (max 100 chars)');
    }
    const item = checkoutBody.parse(req.body);
    const session = await createCheckoutSession(deps, { userId: userIdOf(res), item, idempotencyKey });
    res.status(201).json(session);
  });

  router.get('/checkout/sessions/:id', auth, async (req, res) => {
    res.json(await getCheckoutSession(deps, userIdOf(res), String(req.params.id)));
  });

  return router;
}
