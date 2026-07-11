#!/usr/bin/env node
/**
 * Rebuild derived agent-A/B evaluation fields from immutable response artifacts.
 * It never changes responses, tool traces, wall times, tokens, or costs.
 */
import fs from 'node:fs';
import path from 'node:path';

const apply = process.argv.includes('--apply');
const root = process.cwd();
const resultsDir = path.join(root, 'benchmarks', 'results');
const indexPath = path.join(resultsDir, '_index.jsonl');

const isEligible = (run) =>
  run.evaluation_kind === 'partial' ||
  (run.evaluation_kind === 'deterministic' && Object.keys(run.expected || {}).length > 0);

const providerFailed = (run) =>
  (run.errors || []).some((error) => String(error).startsWith('provider_request_failed:'));

const refreshCondition = (runs) => {
  const eligible = runs.filter((run) => run.evaluation_eligible);
  const correct = eligible.filter((run) => run.correct).length;
  return {
    evaluated_runs: eligible.length,
    excluded_from_evaluation: runs.length - eligible.length,
    functional_success_rate: eligible.length === 0 ? 0 : correct / eligible.length,
    defects_per_task: eligible.length === 0
      ? 0
      : eligible.reduce((total, run) => total + (run.metrics?.fixes_needed || 0), 0) / eligible.length,
  };
};

const rawIndex = fs.existsSync(indexPath)
  ? fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean)
  : [];
const indexEntries = rawIndex.map((line) => JSON.parse(line));
const indexByBaseName = new Map(indexEntries.map((entry, index) => [entry.base_name, index]));
let repairedArtifacts = 0;
let repairedIndexEntries = 0;

for (const file of fs.readdirSync(resultsDir)) {
  if (!file.endsWith('.json') || file.endsWith('.responses.json')) continue;
  const filePath = path.join(resultsDir, file);
  let result;
  try {
    result = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    continue;
  }
  if (!Array.isArray(result.tasks) || !result.summary || !result.config) continue;

  let changed = false;
  for (const run of result.tasks) {
    const eligible = isEligible(run);
    const correct = Boolean(run.correct) && !providerFailed(run);
    if (run.evaluation_eligible !== eligible) {
      run.evaluation_eligible = eligible;
      changed = true;
    }
    if (run.metrics && run.metrics.functional_success !== (eligible && correct)) {
      run.metrics.functional_success = eligible && correct;
      changed = true;
    }
  }

  const withRuns = result.tasks.filter((run) => run.condition === 'with_lynx');
  const withoutRuns = result.tasks.filter((run) => run.condition === 'without_lynx');
  const withRefresh = refreshCondition(withRuns);
  const withoutRefresh = refreshCondition(withoutRuns);
  for (const [target, refresh] of [
    [result.summary.with_lynx, withRefresh],
    [result.summary.without_lynx, withoutRefresh],
  ]) {
    for (const [key, value] of Object.entries(refresh)) {
      if (target[key] !== value) {
        target[key] = value;
        changed = true;
      }
    }
  }

  const baseName = file.slice(0, -'.json'.length);
  const indexPosition = indexByBaseName.get(baseName);
  if (indexPosition !== undefined) {
    const entry = indexEntries[indexPosition];
    const executed = result.tasks.filter((run) => !run.not_executed);
    const providerFailures = executed.filter(providerFailed);
    const pairKeys = new Map();
    for (const run of executed) {
      const key = `${run.task_id}:${run.seed}:${run.order_position}`;
      const conditions = pairKeys.get(key) || new Set();
      conditions.add(run.condition);
      pairKeys.set(key, conditions);
    }
    const completePairs = [...pairKeys.values()].filter(
      (conditions) => conditions.has('with_lynx') && conditions.has('without_lynx'),
    ).length;
    const reasons = entry.invalid_reasons?.includes('rejected_experiment')
      ? ['rejected_experiment']
      : [];
    if (reasons.length === 0) {
      if (result.tasks.length === 0) reasons.push('no_runs');
      if (executed.length === 0) reasons.push('no_executed_runs');
      if (completePairs === 0) reasons.push('no_complete_pairs');
      if (providerFailures.length > 0) reasons.push('provider_request_failed');
    }
    const next = {
      ...entry,
      tier: result.config.tier || 'official',
      valid: reasons.length === 0,
      invalid_reasons: reasons,
      executed_runs: executed.length,
      evaluated_runs: executed.filter((run) => run.evaluation_eligible).length,
      complete_pairs: completePairs,
      lynx: { ...entry.lynx, success_rate: result.summary.with_lynx.functional_success_rate },
      baseline: { ...entry.baseline, success_rate: result.summary.without_lynx.functional_success_rate },
    };
    if (JSON.stringify(next) !== JSON.stringify(entry)) {
      indexEntries[indexPosition] = next;
      repairedIndexEntries++;
    }
  }

  if (changed) {
    repairedArtifacts++;
    if (apply) fs.writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`);
  }
}

if (apply && repairedIndexEntries > 0) {
  fs.writeFileSync(indexPath, `${indexEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

console.log(JSON.stringify({
  mode: apply ? 'applied' : 'dry_run',
  repaired_artifacts: repairedArtifacts,
  repaired_index_entries: repairedIndexEntries,
  note: 'Only derived evaluation and validity fields are recalculated.',
}, null, 2));
