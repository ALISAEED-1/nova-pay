import type { Currency } from '../lib/money.js';
import type { Db } from './index.js';

interface PlanSeed {
  id: string;
  name: string;
  quality: string;
  badge: string | null;
  features: string[];
  prices: Record<Currency, number>;
}

/** Plans and the price book. Re-applied on start so edits here take effect. */
export const PLANS: PlanSeed[] = [
  {
    id: 'basic',
    name: 'Basic',
    quality: 'HD',
    badge: null,
    features: [
      'HD (720p) quality',
      'Watch on 1 device at a time',
      'Watch on your laptop, TV, phone and tablet',
      'Unlimited movies and TV shows',
    ],
    prices: { USD: 999, EUR: 899, PKR: 59900, INR: 19900, BDT: 29900 },
  },
  {
    id: 'standard',
    name: 'Standard',
    quality: 'Full HD',
    badge: 'Most Popular',
    features: [
      'Full HD (1080p) quality',
      'Watch on 2 devices at a time',
      'Watch on your laptop, TV, phone and tablet',
      'Unlimited movies and TV shows',
      'Download on 2 devices',
    ],
    prices: { USD: 1499, EUR: 1399, PKR: 89900, INR: 29900, BDT: 44900 },
  },
  {
    id: 'premium',
    name: 'Premium',
    quality: '4K + HDR',
    badge: null,
    features: [
      '4K (Ultra HD) + HDR quality',
      'Watch on 4 devices at a time',
      'Watch on your laptop, TV, phone and tablet',
      'Unlimited movies and TV shows',
      'Download on 4 devices',
      'Nova Cinema spatial audio',
    ],
    prices: { USD: 1999, EUR: 1799, PKR: 119900, INR: 49900, BDT: 59900 },
  },
];

export async function seedPlans(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [index, plan] of PLANS.entries()) {
      await tx.query(
        `INSERT INTO plans (id, name, quality, badge, features, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, quality = EXCLUDED.quality,
           badge = EXCLUDED.badge, features = EXCLUDED.features, sort_order = EXCLUDED.sort_order`,
        [plan.id, plan.name, plan.quality, plan.badge, JSON.stringify(plan.features), index],
      );
      for (const [currency, amountMinor] of Object.entries(plan.prices)) {
        await tx.query(
          `INSERT INTO plan_prices (plan_id, currency, amount_minor) VALUES ($1, $2, $3)
           ON CONFLICT (plan_id, currency) DO UPDATE SET amount_minor = EXCLUDED.amount_minor`,
          [plan.id, currency, amountMinor],
        );
      }
    }
  });
}
