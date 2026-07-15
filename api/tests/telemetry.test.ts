import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { licensesDb } from '../src/db.js';
import { signLicense } from '../src/jwt.js';

const app = createApp();
const licenseId = 'telemetry-user';
const token = signLicense({ sub: licenseId, email: 'telemetry@example.test', tier: 'pro', machines: [] });

beforeAll(async () => {
  await app.ready();
  licensesDb.prepare(
    'INSERT OR REPLACE INTO users (id, email, tier, billing_status) VALUES (?, ?, ?, ?)'
  ).run(licenseId, 'telemetry@example.test', 'pro', 'active');
  licensesDb.prepare('DELETE FROM telemetry_daily WHERE license_id = ?').run(licenseId);
});

describe('telemetry endpoint', () => {
  it('rejects invalid counters before creating usage data', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/telemetry',
      payload: { license_jwt: token, events: [{ tool: 'search_graph', count: -1 }] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_events' });
    const row = licensesDb.prepare(
      'SELECT 1 FROM telemetry_daily WHERE license_id = ?'
    ).get(licenseId);
    expect(row).toBeUndefined();
  });

  it('rejects a signed token after its billing entitlement is canceled', async () => {
    licensesDb.prepare('UPDATE users SET billing_status = ? WHERE id = ?').run('canceled', licenseId);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/telemetry',
        payload: { license_jwt: token, events: [{ tool: 'search_graph', count: 1 }] },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'inactive_license' });
    } finally {
      licensesDb.prepare('UPDATE users SET billing_status = ? WHERE id = ?').run('active', licenseId);
    }
  });
});
