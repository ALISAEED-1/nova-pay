/**
 * Phase 1 schema. Idempotent, applied on every start. Amounts are BIGINT minor
 * units with a CHAR(3) currency beside them; there are no float money columns.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  country       CHAR(2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plans (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  quality    TEXT NOT NULL,
  badge      TEXT,
  features   JSONB NOT NULL,
  sort_order INT NOT NULL
);

-- Price book: one fixed price per plan per currency (no live FX conversion).
CREATE TABLE IF NOT EXISTS plan_prices (
  plan_id      TEXT NOT NULL REFERENCES plans(id),
  currency     CHAR(3) NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (plan_id, currency)
);

CREATE TABLE IF NOT EXISTS checkout_sessions (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  plan_id             TEXT NOT NULL REFERENCES plans(id),
  amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),
  currency            CHAR(3) NOT NULL,
  provider            TEXT NOT NULL,
  provider_session_id TEXT,
  checkout_url        TEXT,
  status              TEXT NOT NULL CHECK (status IN ('open', 'paid', 'failed')),
  failure_reason      TEXT,
  idempotency_key     TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  UNIQUE (provider, provider_session_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  checkout_session_id TEXT NOT NULL UNIQUE REFERENCES checkout_sessions(id),
  amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),
  currency            CHAR(3) NOT NULL,
  provider            TEXT NOT NULL,
  provider_payment_id TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('succeeded', 'refunded')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);

-- One subscription per user in Phase 1; the price is locked in when it starts.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL UNIQUE REFERENCES users(id),
  plan_id              TEXT NOT NULL REFERENCES plans(id),
  status               TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'canceled')),
  amount_minor         BIGINT NOT NULL CHECK (amount_minor > 0),
  currency             CHAR(3) NOT NULL,
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end   TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every webhook ever received. The primary key is what makes a redelivered
-- event a no-op.
CREATE TABLE IF NOT EXISTS webhook_events (
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  note         TEXT,
  PRIMARY KEY (provider, event_id)
);

-- State owned by the mock provider. Stands in for the provider's own servers.
CREATE TABLE IF NOT EXISTS mock_provider_sessions (
  id           TEXT PRIMARY KEY,
  reference    TEXT NOT NULL UNIQUE,
  amount_minor BIGINT NOT NULL,
  currency     CHAR(3) NOT NULL,
  description  TEXT NOT NULL,
  customer     TEXT NOT NULL,
  return_url   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('open', 'succeeded', 'failed', 'canceled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
