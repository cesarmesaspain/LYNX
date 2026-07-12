import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { signLicense } from '../src/jwt.js';
import { licensesDb } from '../src/db.js';

const app = createApp();

const token = signLicense({ sub: 'rate-limit-user', email: 'rate@example.test', tier: 'pro', machines: [] });

beforeAll(async () => {
  await app.ready();
  licensesDb.prepare('DELETE FROM intelligence_daily_usage').run();
});

describe('intelligence endpoint', () => {
  it('rejects malformed requests before calling providers', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/intelligence', payload: { task: 'detect_test' } });
    expect(response.statusCode).toBe(400);
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
});
