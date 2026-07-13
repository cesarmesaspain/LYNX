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

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

async function waitForRequest(port: number, attempts = 30): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await request(port, '/api/health'); } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw lastError || new Error('Dashboard did not recover');
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

  it('recovers when a temporary port conflict is released', async () => {
    const blocker = http.createServer();
    await listen(blocker, 0);
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('Blocker did not expose a TCP port');

    startDashboard(address.port);
    await new Promise<void>(resolve => blocker.close(() => resolve()));

    const health = await waitForRequest(address.port);
    expect(health.status).toBe(200);
    server = startDashboard(address.port);
  });
});
