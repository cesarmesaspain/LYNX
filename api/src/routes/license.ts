/*
 * license.ts — License management routes.
 *
 * POST /v1/license/activate  — create new license after purchase
 * POST /v1/license/refresh   — refresh JWT (called every 30 days)
 * POST /v1/license/validate  — quick validation (offline fallback)
 */

import type { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import Stripe from 'stripe';
import { signLicense, verifyLicense } from '../jwt.js';
import { resolveLicenseAccess } from '../license-access.js';
import { licensesDb } from '../db.js';
import type { LicenseActivateRequest, LicenseValidateRequest } from '../types.js';

export function licenseRoutes(app: FastifyInstance): void {
  // ── Activate ──────────────────────────────────────
  app.post('/v1/license/activate', async (request, reply) => {
    const { stripe_session_id } = request.body as LicenseActivateRequest;
    if (!stripe_session_id || typeof stripe_session_id !== 'string') {
      return reply.status(400).send({ error: 'missing_stripe_session' });
    }

    const stripeSecret = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecret) return reply.status(503).send({ error: 'stripe_not_configured' });

    let session: Stripe.Checkout.Session;
    try {
      session = await new Stripe(stripeSecret).checkout.sessions.retrieve(stripe_session_id);
    } catch {
      return reply.status(400).send({ error: 'invalid_stripe_session' });
    }

    const email = session.customer_details?.email || session.customer_email;
    if (!email || session.status !== 'complete' || !['paid', 'no_payment_required'].includes(session.payment_status)) {
      return reply.status(403).send({ error: 'unverified_purchase' });
    }
    const tier = tierFromMetadata(session);
    if (!tier) return reply.status(422).send({ error: 'unknown_purchase_tier' });

    // Upsert user
    const existing = licensesDb.prepare('SELECT id, tier FROM users WHERE email = ?').get(email) as any;
    let userId: string;
    if (existing) {
      userId = existing.id;
    } else {
      userId = uuid();
      licensesDb.prepare(
        'INSERT INTO users (id, email, tier, billing_status) VALUES (?, ?, ?, ?)'
      ).run(userId, email, tier, 'active');
    }

    licensesDb.prepare(
      'UPDATE users SET tier = ?, billing_status = ?, stripe_customer_id = ? WHERE id = ?'
    ).run(tier, 'active', typeof session.customer === 'string' ? session.customer : null, userId);

    // Generate license JWT (30 days)
    const jwt = signLicense({
      sub: userId,
      email,
      tier,
      machines: [],
    });

    // Store license key
    const keyId = uuid();
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    licensesDb.prepare(
      'INSERT INTO license_keys (id, user_id, jwt, expires_at) VALUES (?, ?, ?, ?)'
    ).run(keyId, userId, jwt, expiresAt);

    return reply.send({
      license_jwt: jwt,
      tier,
      expires_at: expiresAt,
    });
  });

  // ── Refresh ───────────────────────────────────────
  app.post('/v1/license/refresh', async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'missing_token' });
    }

    const token = auth.slice(7);
    const license = verifyLicense(token);
    if (!license) {
      return reply.status(401).send({ error: 'invalid_license', reason: 'Licencia invalida o expirada.' });
    }

    // Check user billing status
    const user = licensesDb.prepare('SELECT tier, billing_status FROM users WHERE id = ?').get(license.sub) as any;
    if (!user) {
      return reply.status(404).send({ error: 'user_not_found' });
    }

    let newTier = user.tier || 'free';
    // If billing canceled, degrade with 7-day grace
    if (user.billing_status === 'canceled') {
      newTier = 'free';
    }

    // Check if old JWT was revoked
    const oldKey = licensesDb.prepare(
      'SELECT id FROM license_keys WHERE jwt = ? AND revoked = 1'
    ).get(token);
    if (oldKey) {
      return reply.status(401).send({ error: 'license_revoked' });
    }

    const jwt = signLicense({
      sub: license.sub,
      email: license.email,
      tier: newTier as 'free' | 'pro' | 'team' | 'enterprise',
      machines: license.machines || [],
    });

    const keyId = uuid();
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    licensesDb.prepare(
      'INSERT INTO license_keys (id, user_id, jwt, expires_at) VALUES (?, ?, ?, ?)'
    ).run(keyId, license.sub, jwt, expiresAt);

    return reply.send({
      license_jwt: jwt,
      tier: newTier,
      expires_at: expiresAt,
    });
  });

  // ── Validate ──────────────────────────────────────
  app.post('/v1/license/validate', async (request, reply) => {
    const { license_jwt, machine_fingerprint } = request.body as LicenseValidateRequest;

    const access = resolveLicenseAccess(license_jwt);
    if (!access.license) {
      return reply.send({ valid: false, tier: 'free', reason: 'Licencia invalida o expirada.' });
    }
    const license = access.license;

    // Check if this specific JWT was revoked
    const revoked = licensesDb.prepare(
      'SELECT id FROM license_keys WHERE jwt = ? AND revoked = 1'
    ).get(license_jwt);
    if (revoked) {
      return reply.send({ valid: false, tier: 'free', reason: 'Licencia revocada.' });
    }

    // Register machine if not already known
    if (machine_fingerprint && (machine_fingerprint.length > 512 || !/^[A-Za-z0-9._:-]+$/.test(machine_fingerprint))) {
      return reply.status(400).send({ valid: false, tier: 'free', reason: 'Huella de máquina no válida.' });
    }

    if (machine_fingerprint) {
      const user = licensesDb.prepare(
        'SELECT machine_fingerprints, max_machines FROM users WHERE id = ?'
      ).get(license.sub) as any;

      if (user) {
        let machines: string[] = [];
        try {
          machines = JSON.parse(user.machine_fingerprints || '[]');
        } catch { machines = []; }

        if (!machines.includes(machine_fingerprint)) {
          if (machines.length >= user.max_machines) {
            return reply.status(403).send({ valid: false, tier: 'free', reason: 'Límite de máquinas alcanzado.' });
          }
          machines.push(machine_fingerprint);
          licensesDb.prepare(
            'UPDATE users SET machine_fingerprints = ? WHERE id = ?'
          ).run(JSON.stringify(machines), license.sub);
        }
      }
    }

    return reply.send({ valid: true, tier: license.tier });
  });
}

export function tierFromMetadata(session: Stripe.Checkout.Session): 'pro' | 'team' | 'enterprise' | null {
  const tier = session.metadata?.tier;
  return tier === 'pro' || tier === 'team' || tier === 'enterprise' ? tier : null;
}
