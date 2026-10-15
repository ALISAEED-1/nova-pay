import type { Queryable } from './db/index.js';
import { type Currency, type Money, money } from './lib/money.js';

export interface PlanView {
  id: string;
  name: string;
  quality: string;
  badge: string | null;
  features: string[];
  interval: 'month';
  price: Money;
}

interface PlanRow {
  id: string;
  name: string;
  quality: string;
  badge: string | null;
  features: string[];
  amount_minor: number;
}

const toView = (row: PlanRow, currency: Currency): PlanView => ({
  id: row.id,
  name: row.name,
  quality: row.quality,
  badge: row.badge,
  features: row.features,
  interval: 'month',
  price: money(Number(row.amount_minor), currency),
});

const SELECT_PLANS = `
  SELECT p.id, p.name, p.quality, p.badge, p.features, pp.amount_minor
  FROM plans p JOIN plan_prices pp ON pp.plan_id = p.id AND pp.currency = $1`;

/** Plans priced in one currency, from the price book. */
export async function listPlans(db: Queryable, currency: Currency): Promise<PlanView[]> {
  const { rows } = await db.query<PlanRow>(`${SELECT_PLANS} ORDER BY p.sort_order`, [currency]);
  return rows.map((row) => toView(row, currency));
}

export async function findPlan(db: Queryable, planId: string, currency: Currency): Promise<PlanView | undefined> {
  const { rows } = await db.query<PlanRow>(`${SELECT_PLANS} WHERE p.id = $2`, [currency, planId]);
  return rows[0] && toView(rows[0], currency);
}
