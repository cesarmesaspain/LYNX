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
      const rawBody = request.body as string;
      event = stripe.webhooks.constructEvent(
        typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody),
        signature,
        STRIPE_WEBHOOK_SECRET
      );
    } catch {
      return reply.status(400).send({ error: 'invalid_signature' });
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          const email = session.customer_details?.email || session.customer_email;
          const customerId = session.customer as string;

          if (email) {
            await handleCheckoutCompleted(email, customerId, session);
          }
          break;
        }
        case 'customer.subscription.updated': {
          const sub = event.data.object as Stripe.Subscription;
          const customerId = sub.customer as string;
          const status = sub.status;
          await handleSubscriptionUpdated(customerId, status);
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
      app.log.error(err, 'Stripe webhook handler error');
      return reply.status(500).send({ error: 'handler_error' });
    }

    return reply.send({ received: true });
  });
}

async function handleCheckoutCompleted(email: string, customerId: string, session: Stripe.Checkout.Session): Promise<void> {
  // Determine tier from Stripe price/line items
  const tier = 'pro'; // Default — can be refined by price ID lookup

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

async function handleSubscriptionUpdated(customerId: string, status: string): Promise<void> {
  const billingStatus =
    status === 'active' ? 'active' :
    status === 'past_due' ? 'past_due' :
    status === 'canceled' ? 'canceled' :
    status === 'trialing' ? 'trialing' : status;

  licensesDb.prepare(
    'UPDATE users SET billing_status = ? WHERE stripe_customer_id = ?'
  ).run(billingStatus, customerId);
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
