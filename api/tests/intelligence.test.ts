import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { signLicense } from '../src/jwt.js';
import { licensesDb } from '../src/db.js';

const app = createApp();

const token = signLicense({ sub: 'rate-limit-user', email: 'rate@example.test', tier: 'pro', machines: [] });

beforeAll(async () => {
  await app.ready();
  licensesDb.prepare('DELETE FROM intelligence_daily_usage').run();
  licensesDb.prepare(
    'INSERT OR REPLACE INTO users (id, email, tier, billing_status) VALUES (?, ?, ?, ?)'
  ).run('rate-limit-user', 'rate@example.test', 'pro', 'active');
});

describe('intelligence endpoint', () => {
  it('rejects malformed requests before calling providers', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/intelligence', payload: { task: 'detect_test' } });
    expect(response.statusCode).toBe(400);
  });

  it('does not consume quota for an unknown task', async () => {
    licensesDb.prepare('DELETE FROM intelligence_daily_usage WHERE license_id = ?').run('rate-limit-user');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/intelligence',
      payload: { license_jwt: token, task: 'unknown_task', payload: { path: 'a.ts' } },
    });

    expect(response.statusCode).toBe(400);
    const usage = licensesDb.prepare(
      'SELECT requests FROM intelligence_daily_usage WHERE date = ? AND license_id = ?'
    ).get(new Date().toISOString().slice(0, 10), 'rate-limit-user') as { requests: number } | undefined;
    expect(usage).toBeUndefined();
  });

  it('persists the per-day rate limit', async () => {
    licensesDb.prepare(
      'INSERT OR REPLACE INTO intelligence_daily_usage (date, license_id, requests) VALUES (?, ?, ?)'
    ).run(new Date().toISOString().slice(0, 10), 'rate-limit-user', 1000);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/intelligence',
      payload: { license_jwt: token, task: 'detect_test', payload: { path: 'a.ts' } },
    });
    expect(response.statusCode).toBe(429);
  });

  it('allows the final request within the configured daily allowance', async () => {
    licensesDb.prepare(
      'INSERT OR REPLACE INTO intelligence_daily_usage (date, license_id, requests) VALUES (?, ?, ?)'
    ).run(new Date().toISOString().slice(0, 10), 'rate-limit-user', 999);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/intelligence',
      payload: { license_jwt: token, task: 'detect_test', payload: { path: 'a.ts' } },
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a signed token when its current billing entitlement is canceled', async () => {
    licensesDb.prepare(
      'UPDATE users SET billing_status = ? WHERE id = ?'
    ).run('canceled', 'rate-limit-user');

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/intelligence',
        payload: { license_jwt: token, task: 'detect_test', payload: { path: 'a.ts' } },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      licensesDb.prepare(
        'UPDATE users SET billing_status = ? WHERE id = ?'
      ).run('active', 'rate-limit-user');
    }
  });
});
