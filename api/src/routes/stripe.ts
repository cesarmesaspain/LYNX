/*
 * stripe.ts — POST /v1/stripe/webhook route.
 *
 * Handles Stripe events:
 *   checkout.session.completed → activate Pro/Team license
 *   customer.subscription.updated → sync billing status
 *   customer.subscription.deleted → mark for degradation
 *   invoice.payment_failed → mark past_due
 *
 * Stripe webhook signature verification is REQUIRED for security.
 */

import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { v4 as uuid } from 'uuid';
import { licensesDb } from '../db.js';

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

export function stripeRoutes(app: FastifyInstance): void {
  app.post('/v1/stripe/webhook', async (request, reply) => {
    if (!STRIPE_SECRET || !STRIPE_WEBHOOK_SECRET) {
      return reply.status(500).send({ error: 'stripe_not_configured' });
    }

    const stripe = new Stripe(STRIPE_SECRET);
    const signature = request.headers['stripe-signature'] as string;

    let event: Stripe.Event;
    try {
      const rawBody = (request.body as { __rawBody?: Buffer }).__rawBody;
      if (!rawBody) throw new Error('raw body unavailable');
      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        STRIPE_WEBHOOK_SECRET
      );
    } catch {
      return reply.status(400).send({ error: 'invalid_signature' });
    }

    const inserted = licensesDb.prepare(
      'INSERT INTO stripe_events (event_id, event_type) VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING'
    ).run(event.id, event.type);
    if (inserted.changes === 0) return reply.send({ received: true, duplicate: true });

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          const email = session.customer_details?.email || session.customer_email;
          const customerId = session.customer as string;

          if (email) {
            await handleCheckoutCompleted(stripe, email, customerId, session);
          }
          break;
        }
        case 'customer.subscription.updated': {
          const sub = event.data.object as Stripe.Subscription;
          const customerId = sub.customer as string;
          const status = sub.status;
          await handleSubscriptionUpdated(customerId, status, tierFromPriceIds(sub.items.data.map(item => item.price.id)));
          break;
        }
        case 'customer.subscription.deleted': {
          const sub = event.data.object as Stripe.Subscription;
          const customerId = sub.customer as string;
          await handleSubscriptionDeleted(customerId);
          break;
        }
        case 'invoice.payment_failed': {
          const invoice = event.data.object as Stripe.Invoice;
          const customerId = invoice.customer as string;
          await handlePaymentFailed(customerId);
          break;
        }
      }
    } catch (err) {
      licensesDb.prepare('DELETE FROM stripe_events WHERE event_id = ?').run(event.id);
      app.log.error(err, 'Stripe webhook handler error');
      return reply.status(500).send({ error: 'handler_error' });
    }

    return reply.send({ received: true });
  });
}

async function handleCheckoutCompleted(stripe: Stripe, email: string, customerId: string, session: Stripe.Checkout.Session): Promise<void> {
  const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
  const tier = tierFromPriceIds(items.data.map(item => item.price?.id));
  if (!tier) throw new Error('Stripe checkout does not contain a configured tier price');

  const existing = licensesDb.prepare('SELECT id, tier FROM users WHERE email = ?').get(email) as any;

  if (existing) {
    licensesDb.prepare(
      'UPDATE users SET stripe_customer_id = ?, tier = ?, billing_status = ? WHERE id = ?'
    ).run(customerId, tier, 'active', existing.id);
  } else {
    const userId = uuid();
    licensesDb.prepare(
      'INSERT INTO users (id, email, stripe_customer_id, tier, billing_status) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, email, customerId, tier, 'active');
  }
}

export function tierFromPriceIds(priceIds: Array<string | null | undefined>): 'pro' | 'team' | 'enterprise' | null {
  const tiers: Array<['pro' | 'team' | 'enterprise', string | undefined]> = [
    ['pro', process.env.STRIPE_PRO_PRICE_ID],
    ['team', process.env.STRIPE_TEAM_PRICE_ID],
    ['enterprise', process.env.STRIPE_ENTERPRISE_PRICE_ID],
  ];
  return tiers.find(([, priceId]) => priceId && priceIds.includes(priceId))?.[0] ?? null;
}

async function handleSubscriptionUpdated(
  customerId: string,
  status: string,
  tier: 'pro' | 'team' | 'enterprise' | null,
): Promise<void> {
  const billingStatus =
    status === 'active' ? 'active' :
    status === 'past_due' ? 'past_due' :
    status === 'canceled' ? 'canceled' :
    status === 'trialing' ? 'trialing' : status;

  if (tier && (billingStatus === 'active' || billingStatus === 'trialing')) {
    licensesDb.prepare(
      'UPDATE users SET billing_status = ?, tier = ? WHERE stripe_customer_id = ?'
    ).run(billingStatus, tier, customerId);
  } else {
    licensesDb.prepare(
      'UPDATE users SET billing_status = ? WHERE stripe_customer_id = ?'
    ).run(billingStatus, customerId);
  }
}

async function handleSubscriptionDeleted(customerId: string): Promise<void> {
  // Mark for degradation — user gets 7-day grace on next refresh
  licensesDb.prepare(
    'UPDATE users SET billing_status = ?, tier = ? WHERE stripe_customer_id = ?'
  ).run('canceled', 'free', customerId);
}

async function handlePaymentFailed(customerId: string): Promise<void> {
  licensesDb.prepare(
    'UPDATE users SET billing_status = ? WHERE stripe_customer_id = ?'
  ).run('past_due', customerId);
}
