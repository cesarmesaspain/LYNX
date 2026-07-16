/*
 * run-assess.js — Thin wrapper to call handleAssessImpact from CLI/CI.
 *
 * Usage:
 *   node scripts/run-assess.js --project LYNX [--files src/x.ts] [--base-branch main] [--json]
 */

import { handleAssessImpact } from '../dist/mcp/handlers/assess_impact.js';

const args = process.argv.slice(2);
const opts = {};
let jsonOut = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project' && args[i + 1]) { opts.project = args[++i]; }
  else if (args[i] === '--files' && args[i + 1]) { opts.files = args[++i].split(','); }
  else if (args[i] === '--base-branch' && args[i + 1]) { opts.base_branch = args[++i]; }
  else if (args[i] === '--json') { jsonOut = true; }
}

if (!opts.project) {
  console.error('Usage: node scripts/run-assess.js --project <name> [--files a.ts,b.ts] [--base-branch main] [--json]');
  process.exit(1);
}

const result = await handleAssessImpact(opts);
if (jsonOut) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(result.summary);
  console.log('');
  console.log('Blast Radius:', result.direct_dependent_files.length, 'dependent(s)');
  console.log('Event Bridge:', result.async_dependent_files.length, 'dependent(s)');
  console.log('Sibling Invariants:', result.sibling_invariants_broken.length, 'violation(s)');
  console.log('Architecture Rules:', result.architecture_rules_broken.length, 'violation(s)');
  console.log('Findings:', result.total_findings, 'total,', result.returned_findings, 'shown');
}
