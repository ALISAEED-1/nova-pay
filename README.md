# nova-pay

Payment and subscription backend for the [Nova Cinema](https://github.com/ALISAEED-1/Nova-Cinema-App) Flutter app.

The app never handles card details or decides who has paid. nova-pay prices
plans and rentals in the customer's currency, opens a checkout with a payment
provider, and grants access only after the provider confirms the payment.

```
Nova Cinema app ──► nova-pay ──► payment provider (hosted checkout page)
       ▲               ▲                 │
       └── account ────┴──── webhook ◄───┘
```

## What it does

**Phase 1: core**
- Accounts: register and sign in (scrypt password hashes, JWT sessions)
- A price book per currency: USD, EUR, PKR, INR, BDT, picked from the billing country
- Checkout sessions with **idempotency keys**: a retried or double-tapped
  request never creates a second charge
- A **mock payment provider** with a hosted checkout page (Pay, Decline, Cancel)
  that sends **HMAC-signed webhooks** with retries
- Webhook handling that verifies signatures, ignores redelivered events,
  ignores late or out-of-order events, and refuses payments whose amount
  doesn't match the price
- Subscriptions that start (or switch plan) for one month once a payment is confirmed

**Phase 3: Stripe and rentals**
- **Stripe Checkout adapter** (test mode) for US and EU customers, behind the
  same `PaymentProvider` interface as the mock. Without a Stripe key those
  regions fall back to the mock provider automatically.
- Stripe webhooks verified with `Stripe-Signature`; handles paid, still-unpaid
  (bank debits), async success/failure and expired sessions
- **Status checks as a safety net**: while a session is open, asking for its
  status also asks Stripe directly, so a late or missing webhook never leaves a
  paying customer locked out. The outcome is applied once, whichever arrives first.
- Subscription checkouts save the card for future off-session renewals; rentals don't
- **48-hour rentals** of a single title, priced per currency ($3.99, €3.49,
  Rs 199, ₹79, Tk 149). Renting something already rented, or already covered
  by a plan, is refused.
- **Versioned schema migrations** (`schema_migrations`), so existing databases
  upgrade in place

Coming next: JazzCash or Safepay for Pakistan, renewals and dunning, a
double-entry ledger, reconciliation and an admin dashboard.

## Run it

Requires Node 20+. No database install is needed: by default the service runs
an embedded Postgres ([PGlite](https://pglite.dev)) stored in `./data/pglite`.

```bash
npm install
npm start            # http://localhost:4000
npm test             # 35 tests: checkout, rentals, Stripe, webhooks, migrations
npm run typecheck
```

To point the phone at it over USB:

```bash
adb reverse tcp:4000 tcp:4000
```

Demo accounts for testing on a phone (local development database only):
`demo@example.com` / `demo1234` has a plan; `renter@example.com` / `demo1234` has none.

Settings are in `.env` (see `.env.example`). Set `DATABASE_URL` to use a real
Postgres server instead of PGlite.

## Stripe test mode

1. Create a Stripe account and copy the **test** secret key (`sk_test_…`) from
   the dashboard. nova-pay refuses live keys.
2. Put it in `.env` as `STRIPE_SECRET_KEY`.
3. For webhooks on your own machine, install the
   [Stripe CLI](https://docs.stripe.com/stripe-cli) and forward events:
   ```bash
   stripe listen --forward-to localhost:4000/v1/webhooks/stripe
   ```
   Copy the `whsec_…` it prints into `.env` as `STRIPE_WEBHOOK_SECRET`.
   Without it, payments are still confirmed by status checks.
4. Restart, set the billing country to the US, Germany or France in the app,
   and pay with Stripe's test card `4242 4242 4242 4242` (any future date, any CVC).

Stripe accepts merchants only in
[supported countries](https://stripe.com/global); that's why Pakistan and its
neighbours get their own local providers.

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/auth/register` | `{name, email, password, country}` → `{token, account}` |
| POST | `/v1/auth/login` | `{email, password}` → `{token, account}` |
| GET / PATCH | `/v1/me` | Account, subscription and active rentals; PATCH changes `name` or `country` |
| GET | `/v1/regions` | Billing countries and their currencies |
| GET | `/v1/plans` | Plans priced in the user's currency |
| GET | `/v1/rentals/offer` | Rental price and length in the user's currency |
| POST | `/v1/checkout/sessions` | `{planId}` or `{movieId, title}`; requires an `Idempotency-Key` header |
| GET | `/v1/checkout/sessions/:id` | `open`, `paid` or `failed` (asks the provider while open) |
| POST | `/v1/webhooks/:provider` | Signed provider events (`mock`, `stripe`) |

## Layout

```
src/
  server.ts            entry point: config, database, providers, HTTP server
  app.ts, api.ts       routes
  accounts.ts          users and the account view the app shows
  plans.ts             price book lookups
  rentals.ts           rental pricing and active rentals
  checkout.ts          idempotent checkout sessions, status checks
  webhooks.ts          verify → record → apply, in one transaction
  regions.ts           billing country → currency and provider preference
  providers/types.ts   the PaymentProvider interface every adapter implements
  providers/mock/      the mock provider and its hosted checkout page
  providers/stripe/    the Stripe Checkout adapter
  db/                  PGlite / Postgres adapter, migrations, plan seed
  lib/money.ts         integer minor units and currency formatting
test/                  end-to-end tests through the HTTP API (Stripe via a fake HTTP layer)
```
