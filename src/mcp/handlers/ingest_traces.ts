/*
 * ingest_traces.ts — Runtime trace ingestion.
 *
 * Accepts runtime trace objects (HTTP calls, async events, channel messages)
 * and adds corresponding edges to the knowledge graph.
 */

import { getDb } from '../server.js';

interface Trace {
  type: 'http_call' | 'async_call' | 'channel_message';
  from: string;   // qualified_name of source
  to: string;     // qualified_name of target
  metadata?: Record<string, unknown>;
}

export async function handleIngestTraces(
  args: Record<string, unknown>
): Promise<unknown> {
  const project = String(args.project || '');
  const traces = args.traces as Trace[] | undefined;

  if (!project) return { error: 'project is required' };
  if (!traces || !Array.isArray(traces) || traces.length === 0) {
    return { error: 'traces is required and must be a non-empty array' };
  }

  const db = getDb(project);
  let ingested = 0;
  let skipped = 0;

  for (const trace of traces) {
    if (!trace.from || !trace.to || !trace.type) {
      skipped++;
      continue;
    }

    // Find source and target nodes
    const source = db.db
      .prepare('SELECT id FROM nodes WHERE project = ? AND qualified_name = ?')
      .get(project, trace.from) as { id: number } | undefined;

    const target = db.db
      .prepare('SELECT id FROM nodes WHERE project = ? AND qualified_name = ?')
      .get(project, trace.to) as { id: number } | undefined;

    if (!source || !target) {
      skipped++;
      continue;
    }

    const edgeType = traceTypeToEdge(trace.type);

    // Check if this edge already exists
    const existing = db.db
      .prepare(
        'SELECT id FROM edges WHERE project = ? AND source_id = ? AND target_id = ? AND type = ?'
      )
      .get(project, source.id, target.id, edgeType) as { id: number } | undefined;

    if (existing) {
      skipped++;
      continue;
    }

    // Insert edge
    db.db
      .prepare(
        `INSERT INTO edges (project, source_id, target_id, type, properties)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(project, source.id, target.id, edgeType, JSON.stringify(trace.metadata || {}));

    ingested++;
  }

  return {
    ingested,
    skipped,
    total: traces.length,
    message: `Ingested ${ingested} new edges, skipped ${skipped} (already present or nodes not found).`,
  };
}

function traceTypeToEdge(type: Trace['type']): string {
  switch (type) {
    case 'http_call': return 'HTTP_CALLS';
    case 'async_call': return 'ASYNC_CALLS';
    case 'channel_message': return 'CHANNEL';
    default: return 'CALLS';
  }
}
