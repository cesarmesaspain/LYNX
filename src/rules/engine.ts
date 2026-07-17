/*
 * engine.ts — SACG-030 Architecture Drift Prevention.
 *
 * Loads a lynx-rules.json from the project root, maps files to layers via
 * glob patterns, and detects IMPORTS edges that violate the declared
 * dependency rules.
 *
 * Used by:
 *   - assess_impact (architecture_rules_broken)
 *   - Standalone MCP tool: check_rules
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDb } from '../mcp/server.js';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface LayerDef {
  pattern: string;
  description?: string;
}

export interface ForbiddenRule {
  description?: string;
  type: 'forbidden';
  from: string;
  to: string[];
}

export type ArchitectureRule = ForbiddenRule;

export interface LynxRules {
  version: number;
  layers: Record<string, LayerDef>;
  rules: ArchitectureRule[];
}

export interface RuleViolation {
  rule_description: string;
  from_layer: string;
  to_layer: string;
  source_file: string;
  source_symbol: string;
  source_qn: string;
  target_file: string;
  target_symbol: string;
  target_qn: string;
}

export interface CheckRulesResult {
  contract_version: number;
  project: string;
  rules_file_loaded: boolean;
  layers_defined: number;
  rules_defined: number;
  rules: ArchitectureRule[];
  violations: RuleViolation[];
  summary: string;
}

export const CHECK_RULES_CONTRACT_VERSION = 1;

// ═══════════════════════════════════════════════════════════════
// Rule loading
// ═══════════════════════════════════════════════════════════════

const RULES_FILE = 'lynx-rules.json';

export function loadRules(rootPath: string): LynxRules | null {
  const rulesPath = path.join(rootPath, RULES_FILE);
  try {
    const raw = fs.readFileSync(rulesPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.layers || typeof parsed.layers !== 'object') return null;
    if (!Array.isArray(parsed.rules)) return null;
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      layers: parsed.layers as Record<string, LayerDef>,
      rules: parsed.rules as ArchitectureRule[],
    };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// File → Layer mapping
// ═══════════════════════════════════════════════════════════════

function minimatch(filePath: string, pattern: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const regex = globToRegex(pattern);
  return regex.test(normalized);
}

function globToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches any number of path segments
        i += 2;
        if (pattern[i] === '/') i++;
        re += '.*';
      } else {
        // * matches within a single path segment
        i++;
        re += '[^/]*';
      }
    } else if (ch === '?') {
      i++;
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += '\\' + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

function assignLayer(filePath: string, layers: Record<string, LayerDef>): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  for (const [name, def] of Object.entries(layers)) {
    if (minimatch(normalized, def.pattern)) return name;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// Violation detection
// ═══════════════════════════════════════════════════════════════

export function detectArchitectureViolations(
  db: ReturnType<typeof getDb>,
  project: string,
  rules: LynxRules,
  scopedFiles?: string[],
): RuleViolation[] {
  const violations: RuleViolation[] = [];

  // Build layer → layer → forbidden map
  const forbiddenPairs = new Map<string, Set<string>>();
  for (const rule of rules.rules) {
    if (rule.type !== 'forbidden') continue;
    const fromLayer = rule.from;
    let targets = forbiddenPairs.get(fromLayer);
    if (!targets) {
      targets = new Set();
      forbiddenPairs.set(fromLayer, targets);
    }
    for (const toLayer of rule.to) {
      targets.add(toLayer);
    }
  }

  if (forbiddenPairs.size === 0) return [];

  // Load IMPORTS edges with source and target file info
  let rows: Array<{
    source_id: number;
    source_name: string;
    source_qn: string;
    source_file: string;
    target_id: number;
    target_name: string;
    target_qn: string;
    target_file: string;
  }>;

  if (scopedFiles && scopedFiles.length > 0) {
    const placeholders = scopedFiles.map(() => '?').join(',');
    rows = db.db.prepare(
      `SELECT ns.id AS source_id, ns.name AS source_name, ns.qualified_name AS source_qn,
              ns.file_path AS source_file,
              nt.id AS target_id, nt.name AS target_name, nt.qualified_name AS target_qn,
              nt.file_path AS target_file
       FROM edges e
       JOIN nodes ns ON ns.id = e.source_id
       JOIN nodes nt ON nt.id = e.target_id
       WHERE e.project = ? AND e.type = 'IMPORTS'
         AND ns.file_path IN (${placeholders})
         AND nt.kind IN ('Function', 'Method', 'Class', 'Interface')
       ORDER BY ns.file_path`
    ).all(project, ...scopedFiles) as typeof rows;
  } else {
    rows = db.db.prepare(
      `SELECT ns.id AS source_id, ns.name AS source_name, ns.qualified_name AS source_qn,
              ns.file_path AS source_file,
              nt.id AS target_id, nt.name AS target_name, nt.qualified_name AS target_qn,
              nt.file_path AS target_file
       FROM edges e
       JOIN nodes ns ON ns.id = e.source_id
       JOIN nodes nt ON nt.id = e.target_id
       WHERE e.project = ? AND e.type = 'IMPORTS'
         AND nt.kind IN ('Function', 'Method', 'Class', 'Interface')
       ORDER BY ns.file_path`
    ).all(project) as typeof rows;
  }

  for (const row of rows) {
    const sourceLayer = assignLayer(row.source_file, rules.layers);
    const targetLayer = assignLayer(row.target_file, rules.layers);
    if (!sourceLayer || !targetLayer) continue;

    // Check if source's layer can import target's layer
    const forbiddenTargets = forbiddenPairs.get(sourceLayer);
    if (forbiddenTargets && forbiddenTargets.has(targetLayer)) {
      const rule = rules.rules.find(
        r => r.type === 'forbidden' && r.from === sourceLayer && r.to.includes(targetLayer)
      );
      violations.push({
        rule_description: rule?.description || `${sourceLayer} → ${targetLayer} dependency forbidden`,
        from_layer: sourceLayer,
        to_layer: targetLayer,
        source_file: row.source_file,
        source_symbol: row.source_name,
        source_qn: row.source_qn,
        target_file: row.target_file,
        target_symbol: row.target_name,
        target_qn: row.target_qn,
      });
    }
  }

  return violations;
}

// ═══════════════════════════════════════════════════════════════
// MCP handler
// ═══════════════════════════════════════════════════════════════

export async function handleCheckRules(
  args: Record<string, unknown>,
): Promise<CheckRulesResult> {
  const project = String(args.project || '');
  const files = args.files as string[] | undefined;

  const db = getDb(project);
  const projectMeta = db.getProject(project);

  if (!projectMeta) {
    return {
      contract_version: CHECK_RULES_CONTRACT_VERSION,
      project,
      rules_file_loaded: false,
      layers_defined: 0,
      rules_defined: 0,
      rules: [],
      violations: [],
      summary: 'Project not indexed.',
    };
  }

  const rules = loadRules(projectMeta.rootPath);

  if (!rules) {
    return {
      contract_version: CHECK_RULES_CONTRACT_VERSION,
      project,
      rules_file_loaded: false,
      layers_defined: 0,
      rules_defined: 0,
      rules: [],
      violations: [],
      summary: `No ${RULES_FILE} found in project root. Create one to define architecture layers and dependency rules.`,
    };
  }

  const forbiddenRules = rules.rules.filter(r => r.type === 'forbidden');
  const violations = detectArchitectureViolations(db, project, rules, files);

  const summary = violations.length === 0
    ? `All ${forbiddenRules.length} architecture rule(s) respected. No forbidden dependencies detected.`
    : `${violations.length} architecture violation(s) found across ${forbiddenRules.length} rule(s).`;

  return {
    contract_version: CHECK_RULES_CONTRACT_VERSION,
    project,
    rules_file_loaded: true,
    layers_defined: Object.keys(rules.layers).length,
    rules_defined: forbiddenRules.length,
    rules: forbiddenRules,
    violations,
    summary,
  };
}
