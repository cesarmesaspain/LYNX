/*
 * index.ts — LYNX API Server entry point.
 *
 * Fastify server with:
 *   - POST /v1/intelligence      (LLM proxy — never exposes provider)
 *   - POST /v1/license/activate  (new license)
 *   - POST /v1/license/refresh   (30-day refresh)
 *   - POST /v1/license/validate  (offline validation fallback)
 *   - GET  /v1/version           (latest binary info)
 *   - POST /v1/telemetry         (anonymous usage counters)
 *   - POST /v1/stripe/webhook    (Stripe events)
 *   - GET  /health               (health check)
 *
 * Usage:
 *   npm run dev                  # development with tsx
 *   npm run build && npm start   # production
 *
 * Environment variables:
 *   PORT=3001                    (default)
 *   LYNX_QWEN_URL=http://10.0.0.2:8080
 *   LYNX_DEEPSEEK_KEY=sk-...
 *   REDIS_URL=redis://localhost:6379
 *   STRIPE_SECRET_KEY=sk_live_...
 *   STRIPE_WEBHOOK_SECRET=whsec_...
 */

import 'dotenv/config';
import Fastify from 'fastify';
import { intelligenceRoutes } from './routes/intelligence.js';
import { licenseRoutes } from './routes/license.js';
import { versionRoutes } from './routes/version.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { stripeRoutes } from './routes/stripe.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
  },
});

// ── Routes ───────────────────────────────────────────

intelligenceRoutes(app);
licenseRoutes(app);
versionRoutes(app);
telemetryRoutes(app);
stripeRoutes(app);

// ── Health check ─────────────────────────────────────

app.get('/health', async () => {
  return { status: 'ok', uptime: process.uptime() };
});

// ── Start ────────────────────────────────────────────

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`LYNX API server running on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
