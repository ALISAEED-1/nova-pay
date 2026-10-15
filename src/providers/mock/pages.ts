import { escapeHtml, page } from '../../lib/html.js';
import { type Currency, formatMoney } from '../../lib/money.js';

export function checkoutPage(session: {
  id: string;
  description: string;
  customer: string;
  amountMinor: number;
  currency: Currency;
  status: 'open' | 'succeeded' | 'failed' | 'canceled';
}): string {
  const amount = escapeHtml(formatMoney(session.amountMinor, session.currency));
  const action = (name: string) => `/mock-provider/checkout/${encodeURIComponent(session.id)}/${name}`;

  const controls =
    session.status === 'open'
      ? `<form method="post" action="${action('pay')}"><button class="primary" type="submit">Pay ${amount}</button></form>
         <form method="post" action="${action('decline')}"><button class="danger" type="submit">Simulate a declined card</button></form>
         <form method="post" action="${action('cancel')}"><button type="submit">Cancel and go back</button></form>`
      : `<p><strong>This checkout is already ${escapeHtml(session.status)}.</strong></p>`;

  return page(
    'Nova Pay test checkout',
    `<div class="card">
      <span class="badge">Test mode</span>
      <h1>Nova Cinema</h1>
      <div class="muted">${escapeHtml(session.description)}</div>
      <div class="amount">${amount}</div>
      <div class="muted">Billed to ${escapeHtml(session.customer)}</div>
      ${controls}
      <p class="note">This page plays the part of a payment provider's hosted checkout
      (Stripe, JazzCash). No real money moves. In production the customer would enter
      card or wallet details here, on the provider's page, never inside the app.</p>
    </div>`,
  );
}
