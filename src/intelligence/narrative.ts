/*
 * narrative.ts — Generate human-readable explanations from metrics.
 *
 * LYNX differentiator: instead of returning raw numbers, generates
 * English explanations that a developer can understand
 * without decoding complexity metrics.
 */

import type { LynxHotspot, LynxNodeBase } from '../types.js';

export interface Narrative {
  summary: string;
  details: string[];
  riskLevel: 'critical' | 'high' | 'medium' | 'low';
}

const EXTENSION_TO_NAME: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'React TSX',
  '.js': 'JavaScript',
  '.jsx': 'React JSX',
  '.py': 'Python',
  '.kt': 'Kotlin',
  '.java': 'Java',
  '.swift': 'Swift',
  '.go': 'Go',
  '.rs': 'Rust',
  '.c': 'C',
  '.h': 'C Header',
  '.cpp': 'C++',
  '.hpp': 'C++ Header',
  '.cs': 'C#',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.scala': 'Scala',
  '.dart': 'Dart',
  '.lua': 'Lua',
  '.r': 'R',
  '.sh': 'Shell',
  '.bash': 'Bash',
  '.zsh': 'Zsh',
  '.sql': 'SQL',
  '.graphql': 'GraphQL',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.xml': 'XML',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.sass': 'Sass',
  '.less': 'Less',
  '.md': 'Markdown',
  '.mdx': 'MDX',
  '.toml': 'TOML',
  '.ini': 'INI',
  '.cfg': 'Config',
  '.env': 'Env',
  '.dockerfile': 'Dockerfile',
  '.makefile': 'Makefile',
  '.cmake': 'CMake',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
};

function mapExtensionToName(ext: string): string {
  const lower = ext.toLowerCase();
  if (EXTENSION_TO_NAME[lower]) return EXTENSION_TO_NAME[lower];
  if (lower.startsWith('.')) return lower.slice(1).toUpperCase();
  return lower;
}

/**
 * Generate a narrative explanation for a hotspot.
 */
export function explainHotspot(hotspot: LynxHotspot): Narrative {
  const details: string[] = [];
  let riskLevel: Narrative['riskLevel'] = 'low';

  // Complexity assessment
  if (hotspot.complexity > 300) {
    details.push(
      `Extreme cyclomatic complexity (${hotspot.complexity}): this code has ` +
      `${hotspot.complexity} decision points, meaning you would need ` +
      `${hotspot.complexity} tests just to cover all branches.`
    );
    riskLevel = 'critical';
  } else if (hotspot.complexity > 100) {
    details.push(
      `High cyclomatic complexity (${hotspot.complexity}): exceeds the ` +
      `recommended complexity of 10 by ${Math.round(hotspot.complexity / 10)}x. ` +
      `Consider splitting into smaller functions.`
    );
    riskLevel = 'high';
  } else if (hotspot.complexity > 50) {
    details.push(
      `Moderate complexity (${hotspot.complexity}). Acceptable but ` +
      `keep an eye on it so it doesn't grow further.`
    );
    riskLevel = 'medium';
  }

  // Fan-in assessment
  if (hotspot.fanIn > 100) {
    details.push(
      `Massive dependency hub: ${hotspot.fanIn} functions depend on this one. ` +
      `Any change here has an enormous blast radius — ` +
      `run thorough regression tests.`
    );
    riskLevel = 'critical';
  } else if (hotspot.fanIn > 20) {
    details.push(
      `High inbound dependency (${hotspot.fanIn} callers): this is a ` +
      `key coupling point. Document its contract well.`
    );
    if (riskLevel === 'low') riskLevel = 'high';
  } else if (hotspot.fanIn > 5) {
    details.push(
      `${hotspot.fanIn} functions depend on this one. Good reuse, ` +
      `but make sure tests cover all use cases.`
    );
  }

  const name = hotspot.name || hotspot.qualifiedName.split('.').pop() || 'unknown';
  const summary =
    riskLevel === 'critical'
      ? `${name} is a critical system point requiring immediate attention.`
      : riskLevel === 'high'
        ? `${name} has high risk and should be on the refactoring radar.`
        : riskLevel === 'medium'
          ? `${name} has moderate risk — monitor in upcoming iterations.`
          : `${name} has healthy metrics.`;

  return { summary, details, riskLevel };
}

/**
 * Generate an overall architecture health narrative.
 */
export function explainArchitecture(
  totalNodes: number,
  totalEdges: number,
  hotspotCount: number,
  godComponentCount: number,
  avgComplexity: number,
  languages?: Array<{ language: string; fileCount: number }>
): Narrative {
  const details: string[] = [];

  details.push(`The code graph contains ${totalNodes} nodes and ${totalEdges} edges.`);

  // Tech stack
  if (languages && languages.length > 0) {
    const topLangs = languages.slice(0, 6);
    const langParts = topLangs.map(
      (l) => `${mapExtensionToName(l.language)} (${l.fileCount} files)`
    );
    details.push(`Tech stack: ${langParts.join(', ')}.`);
  }

  details.push(
    hotspotCount > 10
      ? `There are ${hotspotCount} hotspots detected — code points with high ` +
        `dependency load that deserve attention.`
      : `${hotspotCount} hotspots detected — a manageable number.`
  );

  if (godComponentCount > 0) {
    details.push(
      `${godComponentCount} components exceed 1000 lines — ` +
      `consider splitting them to improve maintainability.`
    );
    details.push(
      `"God components" are the main source of bugs in ` +
      `TypeScript projects: more lines, higher probability of errors per change.`
    );
  }

  if (avgComplexity > 20) {
    details.push(
      `Average complexity (${avgComplexity.toFixed(1)}) is high. ` +
      `The recommended threshold per function is 10. Consider simplifying ` +
      `the most complex functions.`
    );
  }

  const riskLevel =
    hotspotCount > 15 || godComponentCount > 3 ? 'high' : hotspotCount > 5 ? 'medium' : 'low';

  const summary =
    riskLevel === 'high'
      ? 'The architecture has significant structural risks. Prioritize tech debt.'
      : riskLevel === 'medium'
        ? 'The architecture is acceptable but has identified improvement areas.'
        : 'The architecture appears healthy. Keep monitoring.';

  return { summary, details, riskLevel };
}

// ── Per-tool narrative helpers (Bloque E) ────────────────────────

export interface SearchNarrative {
  summary: string;
  top3: string[];
}

/**
 * Narrative for search_graph results — helps interpret what was found.
 */
export function narrateSearchResults(
  results: Array<{ node: LynxNodeBase & { id: number } }>,
  total: number,
  query: string
): SearchNarrative {
  if (results.length === 0) {
    return {
      summary: `No symbols found for "${query}". Try different terms or check that the project is indexed.`,
      top3: [],
    };
  }

  // Count by kind
  const byKind = new Map<string, number>();
  for (const r of results) {
    byKind.set(r.node.kind, (byKind.get(r.node.kind) || 0) + 1);
  }
  const kindSummary = [...byKind.entries()]
    .map(([k, c]) => `${c} ${k}${c > 1 ? 's' : ''}`)
    .join(', ');

  const top3 = results.slice(0, 3).map((r) => r.node.name);

  const summary =
    results.length < total
      ? `${total} results for "${query}" (showing ${results.length}). ${kindSummary}. Most relevant: ${top3.join(', ')}.`
      : `${results.length} results for "${query}". ${kindSummary}. Most relevant: ${top3.join(', ')}.`;

  return { summary, top3 };
}

export interface TraversalNarrative {
  summary: string;
  deepestPath: string;
}

/**
 * Narrative for trace_path — tells the story of a call chain.
 */
export function narrateTraversal(
  rootName: string,
  visitedCount: number,
  maxHop: number,
  edges: Array<{ fromName: string; toName: string }>
): TraversalNarrative {
  if (visitedCount === 0) {
    return {
      summary: `${rootName} has no registered call connections in the graph.`,
      deepestPath: rootName,
    };
  }

  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.fromName) || [];
    list.push(e.toName);
    adjacency.set(e.fromName, list);
  }

  // DFS to find the deepest chain from root
  function dfs(node: string, visited: Set<string>): string[] {
    const neighbors = adjacency.get(node) || [];
    let best: string[] = [];
    for (const next of neighbors) {
      if (visited.has(next)) continue;
      visited.add(next);
      const tail = dfs(next, visited);
      visited.delete(next);
      if (tail.length + 1 > best.length) best = [next, ...tail];
    }
    return best;
  }

  const visited = new Set<string>([rootName]);
  const tail = dfs(rootName, visited);
  const deepestPath = [rootName, ...tail].join(' → ');

  const summary =
    maxHop <= 1
      ? `From ${rootName}, ${visitedCount} nodes are reachable in 1 hop. It's a function with direct dependencies and no deep chains.`
      : tail.length > 0
        ? `From ${rootName}, ${visitedCount} nodes are reachable in up to ${maxHop} hops. ` +
          `The deepest chain: ${deepestPath}.`
        : `From ${rootName}, ${visitedCount} nodes are reachable in up to ${maxHop} hops, but no multi-hop chains were found — all connections are direct.`;

  return { summary, deepestPath };
}

export interface SnippetNarrative {
  role: string;
  complexityNote: string | null;
}

/**
 * Narrative for get_code_snippet — contextualizes a symbol with its metrics.
 */
export function narrateSnippet(
  node: LynxNodeBase & { id: number },
  callers: string[],
  callees: string[],
  complexity?: number
): SnippetNarrative {
  const name = node.name;

  let role: string;
  if (callers.length > 20) {
    role = `${name} is a central piece of the system: ${callers.length} functions depend on it. It's a critical coupling point — any change has high impact.`;
  } else if (callers.length > 5) {
    role = `${name} is used by ${callers.length} functions and calls ${callees.length}. ` +
      `Good reuse with moderate coupling.`;
  } else if (callers.length > 0) {
    role = `${name} is called by ${callers.length} function(s): ${callers.slice(0, 5).join(', ')}. ` +
      `Low inbound coupling.`;
  } else if (callees.length > 0) {
    role = `${name} receives no direct calls but invokes ${callees.length} function(s): ${callees.slice(0, 5).join(', ')}. ` +
      `Seems to be an entry point or orchestrator function.`;
  } else {
    role = `${name} is an isolated function — it neither calls nor is called by other known functions in the graph.`;
  }

  let complexityNote: string | null = null;
  if (complexity !== undefined && complexity > 10) {
    const ratio = Math.round(complexity / 10);
    complexityNote =
      complexity > 100
        ? `Alert: complexity ${complexity} (${ratio}x the recommended threshold). This function has too many decision points. Split it into smaller functions to reduce bug risk.`
        : `Complexity ${complexity} (${ratio}x the threshold of 10). Keep an eye on it — if it keeps growing, consider refactoring.`;
  } else if (complexity !== undefined) {
    complexityNote = `Complexity ${complexity} — within the healthy range (<=10).`;
  }

  return { role, complexityNote };
}
