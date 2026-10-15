import type { Queryable } from './db/index.js';
import { type Currency, type Money, money } from './lib/money.js';

export const RENTAL_HOURS = 48;

/** One rental price per currency, the same for every title. */
const RENTAL_PRICES: Record<Currency, number> = {
  USD: 399,
  EUR: 349,
  PKR: 19900,
  INR: 7900,
  BDT: 14900,
};

export interface RentalOffer {
  hours: number;
  price: Money;
}

export interface RentalView {
  movieId: string;
  title: string;
  expiresAt: string;
}

export const rentalOffer = (currency: Currency): RentalOffer => ({
  hours: RENTAL_HOURS,
  price: money(RENTAL_PRICES[currency], currency),
});

/** Rentals that can still be watched, soonest to expire first. */
export async function activeRentals(db: Queryable, userId: string): Promise<RentalView[]> {
  const { rows } = await db.query<{ movie_id: string; title: string; expires_at: Date }>(
    `SELECT DISTINCT ON (movie_id) movie_id, title, expires_at FROM rentals
     WHERE user_id = $1 AND expires_at > now()
     ORDER BY movie_id, expires_at DESC`,
    [userId],
  );
  return rows
    .map((r) => ({ movieId: r.movie_id, title: r.title, expiresAt: r.expires_at.toISOString() }))
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
}
