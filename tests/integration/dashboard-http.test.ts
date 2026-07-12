import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { startDashboard } from '../../src/server/dashboard/server.js';

function waitForListening(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Dashboard did not expose a TCP port'));
      else resolve(address.port);
    });
  });
}

function request(port: number, path: string, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET' }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('local dashboard HTTP boundary', () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
  });

  it('serves loopback health without permissive CORS and rejects oversized mutations', async () => {
    server = startDashboard(0);
    const port = await waitForListening(server);
    const health = await request(port, '/api/health');
    expect(health.status).toBe(200);
    expect(health.headers['access-control-allow-origin']).toBeUndefined();

    const tooLarge = await request(port, '/api/projects/add', 'x'.repeat(1_048_577));
    expect(tooLarge.status).toBe(413);
  });
});
