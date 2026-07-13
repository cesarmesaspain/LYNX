import type Stripe from 'stripe';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, parseJsonWithRawBody } from '../src/app.js';
import { licensesDb } from '../src/db.js';
import { signLicense } from '../src/jwt.js';
import { tierFromMetadata } from '../src/routes/license.js';
import { tierFromPriceIds } from '../src/routes/stripe.js';

describe('billing security boundaries', () => {
  const originalPrices = {
    pro: process.env.STRIPE_PRO_PRICE_ID,
    team: process.env.STRIPE_TEAM_PRICE_ID,
    enterprise: process.env.STRIPE_ENTERPRISE_PRICE_ID,
  };

  afterEach(() => {
    process.env.STRIPE_PRO_PRICE_ID = originalPrices.pro;
    process.env.STRIPE_TEAM_PRICE_ID = originalPrices.team;
    process.env.STRIPE_ENTERPRISE_PRICE_ID = originalPrices.enterprise;
  });

  it('preserves exact JSON bytes for webhook signature verification', () => {
    const raw = Buffer.from('{ "event": "checkout.session.completed" }');
    const parsed = parseJsonWithRawBody(raw);

    expect(parsed).toEqual({ event: 'checkout.session.completed' });
    expect((parsed as { __rawBody: Buffer }).__rawBody).toBe(raw);
    expect(Object.keys(parsed)).not.toContain('__rawBody');
  });

  it('accepts only known, signed-checkout metadata tiers', () => {
    expect(tierFromMetadata({ metadata: { tier: 'team' } } as Stripe.Checkout.Session)).toBe('team');
    expect(tierFromMetadata({ metadata: { tier: 'free' } } as Stripe.Checkout.Session)).toBeNull();
  });

  it('maps subscription prices only from configured Stripe price IDs', () => {
    process.env.STRIPE_PRO_PRICE_ID = 'price_pro';
    process.env.STRIPE_TEAM_PRICE_ID = 'price_team';
    process.env.STRIPE_ENTERPRISE_PRICE_ID = 'price_enterprise';

    expect(tierFromPriceIds(['price_team'])).toBe('team');
    expect(tierFromPriceIds(['untrusted-price'])).toBeNull();
  });

  it('rejects a signed license after its billing entitlement is canceled', async () => {
    const userId = 'canceled-license-user';
    const token = signLicense({ sub: userId, email: 'canceled@example.test', tier: 'pro', machines: [] });
    licensesDb.prepare(
      'INSERT OR REPLACE INTO users (id, email, tier, billing_status) VALUES (?, ?, ?, ?)'
    ).run(userId, 'canceled@example.test', 'pro', 'canceled');
    const app = createApp();
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/license/validate',
        payload: { license_jwt: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ valid: false, tier: 'free' });
    } finally {
      await app.close();
      licensesDb.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
  });
});
