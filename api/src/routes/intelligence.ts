/*
 * intelligence.ts — POST /v1/intelligence route.
 *
 * This is the core endpoint. It routes intelligence tasks to the best available
 * provider (Qwen 14B → DeepSeek → heuristic). The payload NEVER contains source code.
 *
 * Rate limit: 1000 req/day for Pro, 5000 for Team.
 */

import type { FastifyInstance } from 'fastify';
import { routeIntelligence } from '../intelligence/router.js';
import { verifyLicense } from '../jwt.js';
import { licensesDb } from '../db.js';
import type { IntelligenceRequest } from '../types.js';

const RATE_LIMITS: Record<string, number> = {
  free: 0,       // Free tier can't use intelligence API
  pro: 1000,     // 1000 req/day
  team: 5000,    // 5000 req/day
  enterprise: -1, // unlimited
};

function checkRateLimit(licenseId: string, tier: string): boolean {
  const limit = RATE_LIMITS[tier];
  if (limit === undefined || limit === -1) return true;
  if (limit === 0) return false;

  const today = new Date().toISOString().slice(0, 10);
  const result = licensesDb.prepare(`
    INSERT INTO intelligence_daily_usage (date, license_id, requests)
    VALUES (?, ?, 1)
    ON CONFLICT(date, license_id) DO UPDATE SET requests = requests + 1
    WHERE requests < ?
  `).run(today, licenseId, limit);
  return result.changes === 1;
}

export function intelligenceRoutes(app: FastifyInstance): void {
  app.post('/v1/intelligence', async (request, reply) => {
    const body = request.body as IntelligenceRequest;

    if (!body || typeof body !== 'object' || typeof body.license_jwt !== 'string' ||
      typeof body.task !== 'string' || !body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
      return reply.status(400).send({ error: 'invalid_request' });
    }

    // Validate JWT
    const license = verifyLicense(body.license_jwt);
    if (!license) {
      return reply.status(401).send({ error: 'invalid_license', reason: 'Licencia invalida o expirada.' });
    }

    // Check rate limit
    if (!checkRateLimit(license.sub, license.tier)) {
      return reply.status(429).send({
        error: 'rate_limited',
        reason: 'Limite diario de inteligencia alcanzado. Actualiza a Team para mas capacidad.',
      });
    }

    // Validate task
    const validTasks = ['summarize_module', 'rerank_search', 'assess_change_risk', 'detect_entry_point', 'classify_code_smell', 'detect_test'];
    if (!validTasks.includes(body.task)) {
      return reply.status(400).send({ error: 'invalid_task', reason: `Tarea desconocida: ${body.task}` });
    }

    const response = await routeIntelligence(body, license.sub);
    return reply.send(response);
  });
}
