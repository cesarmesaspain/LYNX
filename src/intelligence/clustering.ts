/*
 * clustering.ts — Label propagation community detection.
 *
 * LYNX uses label propagation for community detection.
 * It's simpler, still effective for code graphs, and doesn't require
 * a C implementation. Communities form around import/call clusters.
 *
 * Algorithm: Raghavan, Albert & Kumara 2007, "Near linear time algorithm
 * to detect community structures in large-scale networks"
 */

import type { LynxDatabase } from '../store/database.js';
import type { LynxCluster } from '../types.js';

export function detectClusters(
  db: LynxDatabase,
  project: string,
  maxClusters = 12
): LynxCluster[] {
  // Get all Function/Method/Class nodes
  const nodes = db.db
    .prepare(
      `SELECT id, name, qualified_name, file_path, kind
       FROM nodes WHERE project = ? AND kind IN ('Function', 'Method', 'Class', 'Interface', 'Type')`
    )
    .all(project) as { id: number; name: string; qualified_name: string; file_path: string; kind: string }[];

  if (nodes.length < 5) return [];

  // Build adjacency from CALLS + IMPORTS edges (weighted)
  const edges = db.db
    .prepare(
      `SELECT source_id, target_id, type
       FROM edges WHERE project = ? AND type IN ('CALLS', 'IMPORTS', 'HTTP_CALLS', 'ASYNC_CALLS')`
    )
    .all(project) as { source_id: number; target_id: number; type: string }[];

  const idToIndex = new Map<number, number>();
  nodes.forEach((n, i) => idToIndex.set(n.id, i));

  // Build adjacency list for the subset
  const n = nodes.length;
  const adj: number[][] = Array.from({ length: n }, () => []);

  for (const edge of edges) {
    const si = idToIndex.get(edge.source_id);
    const ti = idToIndex.get(edge.target_id);
    if (si !== undefined && ti !== undefined && si !== ti) {
      adj[si].push(ti);
      adj[ti].push(si); // Undirected for community detection
    }
  }

  // Initialize: each node is its own community
  const labels = Array.from({ length: n }, (_, i) => i);

  // Label propagation: iterate until convergence (max 50 iterations)
  for (let iter = 0; iter < 50; iter++) {
    let changed = false;

    // Random order each iteration
    const order = Array.from({ length: n }, (_, i) => i);
    shuffle(order);

    for (const i of order) {
      if (adj[i].length === 0) continue;

      // Count labels of neighbors
      const labelCounts = new Map<number, number>();
      for (const neighbor of adj[i]) {
        const label = labels[neighbor];
        labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
      }

      // Pick the most frequent label (ties broken randomly)
      let maxCount = 0;
      const bestLabels: number[] = [];
      for (const [label, count] of labelCounts) {
        if (count > maxCount) {
          maxCount = count;
          bestLabels.length = 0;
          bestLabels.push(label);
        } else if (count === maxCount) {
          bestLabels.push(label);
        }
      }

      const newLabel = bestLabels[Math.floor(Math.random() * bestLabels.length)];
      if (labels[i] !== newLabel) {
        labels[i] = newLabel;
        changed = true;
      }
    }

    if (!changed) break;
  }

  // Group nodes by community label
  const communities = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const label = labels[i];
    if (!communities.has(label)) communities.set(label, []);
    communities.get(label)!.push(i);
  }

  // Score communities: compute cohesion = internal_edges / (internal + external)
  const communityList = Array.from(communities.entries())
    .map(([label, members]) => {
      const memberSet = new Set(members);
      let internalEdges = 0;
      let externalEdges = 0;

      for (const idx of members) {
        for (const neighbor of adj[idx]) {
          if (memberSet.has(neighbor)) {
            internalEdges++;
          } else {
            externalEdges++;
          }
        }
      }

      internalEdges /= 2; // Each internal edge counted twice
      const total = internalEdges + externalEdges;
      const cohesion = total > 0 ? internalEdges / total : 0;

      // Top nodes by degree within community
      const topNodes = members
        .sort((a, b) => adj[b].length - adj[a].length)
        .slice(0, 5)
        .map((idx) => nodes[idx].qualified_name);

      // Dominant packages (first segment of qualified_name)
      const packages = new Set<string>();
      for (const idx of members) {
        const qn = nodes[idx].qualified_name;
        const firstDot = qn.indexOf('.');
        if (firstDot > 0) packages.add(qn.substring(0, firstDot));
      }

      return {
        id: label,
        label: computeClusterLabel(members, nodes),
        members: members.length,
        cohesion: Math.round(cohesion * 10000) / 10000,
        topNodes,
        packages: Array.from(packages).slice(0, 3),
        edgeTypes: ['CALLS', 'IMPORTS'],
      };
    })
    .filter((c) => c.members >= 3) // Filter singletons and tiny clusters
    .sort((a, b) => b.members - a.members)
    .slice(0, maxClusters);

  return communityList;
}

function computeClusterLabel(
  members: number[],
  nodes: { name: string; qualified_name: string; file_path: string }[]
): string {
  // Most common name fragment among members
  const wordCounts = new Map<string, number>();
  for (const idx of members) {
    const words = nodes[idx].name.split(/(?=[A-Z])/);
    for (const w of words) {
      const lower = w.toLowerCase();
      if (lower.length >= 3) {
        wordCounts.set(lower, (wordCounts.get(lower) || 0) + 1);
      }
    }
  }
  const topWords = Array.from(wordCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([w]) => w);
  return topWords.join('/') || 'cluster';
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
