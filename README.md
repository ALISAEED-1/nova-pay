# nova-pay

Payment and subscription backend for the [Nova Cinema](https://github.com/ALISAEED-1/Nova-Cinema-App) Flutter app.

The app never handles card details or decides who has paid. nova-pay prices
plans in the customer's currency, opens a checkout with a payment provider, and
grants a plan only after the provider's signed webhook confirms the payment.

```
Nova Cinema app ──► nova-pay ──► payment provider (hosted checkout page)
       ▲               ▲                 │
       └── account ────┴──── webhook ◄───┘
```

## Phase 1 (this version)

- Accounts: register and sign in (scrypt password hashes, JWT sessions)
- A price book per currency: USD, EUR, PKR, INR, BDT, picked from the billing country
- Checkout sessions with **idempotency keys**: a retried or double-tapped
  request never creates a second charge
- A **mock payment provider** with a hosted checkout page (Pay, Decline, Cancel)
  that sends **HMAC-signed webhooks** with retries, standing in for Stripe or JazzCash
- Webhook handling that verifies signatures, ignores redelivered events,
  ignores late or out-of-order events, and refuses payments whose amount
  doesn't match the price
- Subscriptions that start (or switch plan) for one month once a payment is confirmed

Coming next: Stripe for the US/EU, JazzCash or Safepay for Pakistan, renewals
and dunning, a double-entry ledger, reconciliation and an admin dashboard.

## Run it

Requires Node 20+. No database install is needed: by default the service runs
an embedded Postgres ([PGlite](https://pglite.dev)) stored in `./data/pglite`.

```bash
npm install
npm start            # http://localhost:4000
npm test             # 17 tests: checkout, idempotency, webhooks, pricing
npm run typecheck
```

To point the phone at it over USB:

```bash
adb reverse tcp:4000 tcp:4000
```

A demo account used for testing on a phone: `demo@example.com` / `demo1234`
(local development database only).

Settings are in `.env` (see `.env.example`). Set `DATABASE_URL` to use a real
Postgres server instead of PGlite.

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/auth/register` | `{name, email, password, country}` → `{token, account}` |
| POST | `/v1/auth/login` | `{email, password}` → `{token, account}` |
| GET / PATCH | `/v1/me` | Account and subscription; PATCH changes `name` or `country` |
| GET | `/v1/regions` | Billing countries and their currencies |
| GET | `/v1/plans` | Plans priced in the user's currency |
| POST | `/v1/checkout/sessions` | `{planId}`; requires an `Idempotency-Key` header |
| GET | `/v1/checkout/sessions/:id` | `open`, `paid` or `failed` |
| POST | `/v1/webhooks/:provider` | Signed provider events |

## Layout

```
src/
  server.ts            entry point: config, database, provider, HTTP server
  app.ts, api.ts       routes
  accounts.ts          users and the account view the app shows
  plans.ts             price book lookups
  checkout.ts          idempotent checkout sessions
  webhooks.ts          verify → record → apply, in one transaction
  regions.ts           billing country → currency and provider
  providers/types.ts   the PaymentProvider interface every adapter implements
  providers/mock/      the mock provider and its hosted checkout page
  db/                  PGlite / Postgres adapter, schema, plan seed
  lib/money.ts         integer minor units and currency formatting
test/                  end-to-end tests through the HTTP API
```
