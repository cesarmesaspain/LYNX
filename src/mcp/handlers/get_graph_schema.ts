/*
 * get_graph_schema.ts — Graph schema introspection.
 *
 * Returns node label counts, edge type counts, relationship patterns,
 * and sample names.
 */

import { getDb } from '../server.js';
import { getSchema } from '../../store/schema.js';

export async function handleGetGraphSchema(
  args: Record<string, unknown>
): Promise<unknown> {
  const project = String(args.project || '');

  if (!project) return { error: 'project is required' };

  const db = getDb(project);
  const schema = getSchema(db, project);

  return {
    node_labels: schema.nodeLabels.map(l => ({
      label: l.label,
      count: l.count,
      properties: l.properties,
    })),
    edge_types: schema.edgeTypes,
    relationship_patterns: schema.relPatterns,
    sample_functions: schema.sampleFunctionNames,
    sample_classes: schema.sampleClassNames,
  };
}
