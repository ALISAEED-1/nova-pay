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

**Phase 4: renewals, dunning, grace and cancel**
- A **billing job** (every minute, idempotent) that raises each period's
  invoice 3 days early, at the price the customer locked in
- **Two ways to renew**:
  - **Automatic:** a saved card is charged off-session on the due date (mock
    cards, or a Stripe customer's card)
  - **Manual:** for mobile wallets like JazzCash or Easypaisa, which can't be
    charged later; the customer pays the open invoice from the app
- **Dunning:** a declined card is retried after 1, 3 and 5 days. The plan goes
  `past_due` but keeps working through a **7-day grace period**, then ends.
  Each attempt's idempotency key carries its number, so a crash after charging
  can't charge twice.
- **Pay now:** any open invoice can be paid through a checkout, which also
  replaces the saved card; paying late carries the subscription on from where it was
- **Cancel / resume:** an active plan runs to the end of the paid period; a
  past-due plan ends at once. Resume restores the renewal invoice.
- A `billing_events` log (reminder, payment failed, renewed, ended): the
  emails a production system would send
- **Dev clock:** `POST /v1/dev/advance-clock {days}` moves one account's dates
  forward and runs billing, so a demo can show a month passing. Off in production.

Coming next: JazzCash or Safepay for Pakistan, refunds, proration on plan
changes, a double-entry ledger, reconciliation and an admin dashboard.

## Run it

Requires Node 20+. No database install is needed: by default the service runs
an embedded Postgres ([PGlite](https://pglite.dev)) stored in `./data/pglite`.

```bash
npm install
npm start            # http://localhost:4000
npm test             # 49 tests: checkout, rentals, renewals, dunning, Stripe, webhooks, migrations
npm run typecheck
```

To point the phone at it over USB:

```bash
adb reverse tcp:4000 tcp:4000
```

Demo accounts for testing on a phone (local development database only), all
with password `demo1234`:
- `demo@example.com`: a plan that renews by hand
- `renter@example.com`: no plan, one rental
- `dunning@example.com`: a plan renewing on a saved Visa

To see dunning on the test checkout page, pay with **Mastercard •••• 0341**,
which works today but declines at renewal. Then use *Developer: skip ahead*
in the app's Profile.

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
| POST | `/v1/checkout/sessions` | `{planId}`, `{movieId, title}` or `{invoiceId}`; requires an `Idempotency-Key` header |
| GET | `/v1/checkout/sessions/:id` | `open`, `paid` or `failed` (asks the provider while open) |
| POST | `/v1/subscription/cancel` | Cancel at period end (or at once if past due) |
| POST | `/v1/subscription/resume` | Undo a cancellation before the period ends |
| GET | `/v1/subscription/invoices` | Billing history |
| GET | `/v1/subscription/events` | Billing activity (reminders, failures, renewals) |
| POST | `/v1/webhooks/:provider` | Signed provider events (`mock`, `stripe`) |
| POST | `/v1/dev/advance-clock` | Dev only: `{days}` forward for this account, then run billing |

## Layout

```
src/
  server.ts            entry point: config, database, providers, HTTP server
  app.ts, api.ts       routes
  accounts.ts          users and the account view the app shows
  plans.ts             price book lookups
  rentals.ts           rental pricing and active rentals
  checkout.ts          idempotent checkout sessions, status checks
  billing.ts           the renewal job: invoices, charges, retries, grace, cancel
  webhooks.ts          verify → record → apply, in one transaction
  regions.ts           billing country → currency and provider preference
  providers/types.ts   the PaymentProvider interface every adapter implements
  providers/mock/      the mock provider and its hosted checkout page
  providers/stripe/    the Stripe Checkout adapter
  db/                  PGlite / Postgres adapter, migrations, plan seed
  lib/money.ts         integer minor units and currency formatting
test/                  end-to-end tests through the HTTP API (Stripe via a fake HTTP layer)
```
