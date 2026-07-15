/*
 * telemetry.ts — POST /v1/telemetry route.
 *
 * Opt-in anonymous usage counters. No source code, no paths, no function names.
 * GDPR-compliant by design — we only store: "user X did N search_graph calls today".
 */

import type { FastifyInstance } from 'fastify';
import { licensesDb } from '../db.js';
import { resolveLicenseAccess } from '../license-access.js';
import type { TelemetryRequest } from '../types.js';

export function telemetryRoutes(app: FastifyInstance): void {
  app.post('/v1/telemetry', async (request, reply) => {
    const { license_jwt, events } = request.body as TelemetryRequest;

    if (
      !events ||
      !Array.isArray(events) ||
      events.length === 0 ||
      events.length > 1000 ||
      events.some(event =>
        !event ||
        typeof event.tool !== 'string' ||
        !Number.isSafeInteger(event.count) ||
        event.count < 0 ||
        event.count > 1_000_000
      )
    ) {
      return reply.status(400).send({ error: 'invalid_events' });
    }

    const access = resolveLicenseAccess(license_jwt);
    if (!access.license) {
      return reply.status(401).send({ error: access.reason });
    }
    const license = access.license;

    const today = new Date().toISOString().slice(0, 10);
    const upsert = licensesDb.prepare(`
      INSERT INTO telemetry_daily (date, license_id, tool_calls, search_graph_calls, trace_path_calls, index_calls, detect_changes_calls)
      VALUES (?, ?, 0, 0, 0, 0, 0)
      ON CONFLICT(date, license_id) DO NOTHING
    `);
    upsert.run(today, license.sub);

    for (const evt of events) {
      const col = toolToColumn(evt.tool);
      if (col) {
        licensesDb.prepare(
          `UPDATE telemetry_daily SET ${col} = ${col} + ? WHERE date = ? AND license_id = ?`
        ).run(evt.count, today, license.sub);
      }
    }

    // Also update total tool calls
    const totalCols = events
      .map(e => toolToColumn(e.tool))
      .filter(Boolean)
      .map(c => `${c} = ${c} + 0`);
    if (totalCols.length > 0) {
      licensesDb.prepare(
        `UPDATE telemetry_daily SET tool_calls = tool_calls + ? WHERE date = ? AND license_id = ?`
      ).run(events.reduce((sum, e) => sum + e.count, 0), today, license.sub);
    }

    return reply.send({ ok: true });
  });
}

function toolToColumn(tool: string): string | null {
  switch (tool) {
    case 'search_graph': return 'search_graph_calls';
    case 'trace_path': return 'trace_path_calls';
    case 'index_repository': return 'index_calls';
    case 'detect_changes': return 'detect_changes_calls';
    default: return null; // other tools just count toward total
  }
}
