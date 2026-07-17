#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { validateNativeStaging } from '../dist/native-core/staging.js';

const root = path.resolve(import.meta.dirname, '..');
const repo = path.resolve(process.argv[2] || '.');
const workers = Math.max(1, Number(process.argv[3]) || os.availableParallelism());
const ignored = new Set(['.git', 'node_modules', 'build', 'dist', 'vendor', 'vendored', '.cache']);
const extensions = new Map([
  ['.c', 'c'], ['.h', 'c'], ['.cc', 'cpp'], ['.cpp', 'cpp'],
  ['.cxx', 'cpp'], ['.hh', 'cpp'], ['.hpp', 'cpp'], ['.hxx', 'cpp'],
]);
const files = [];

function discover(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) discover(absolute);
    else if (entry.isFile()) {
      const language = extensions.get(path.extname(entry.name).toLowerCase());
      if (language) files.push({ language, absolute, relative: path.relative(repo, absolute) });
    }
  }
}
discover(repo);
files.sort((left, right) => left.relative.localeCompare(right.relative));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-benchmark-'));
const manifest = path.join(work, 'manifest.tsv');
const staging = path.join(work, 'staging.db');
fs.writeFileSync(manifest, files.map((file) =>
  `${file.language}\t${file.relative}\t${file.absolute}`,
).join('\n') + '\n');

const started = performance.now();
const run = spawnSync(path.join(root, 'native/lynx_native_core'), [
  'native-benchmark', repo, manifest, staging, String(workers), 'full',
], { cwd: root, encoding: 'utf8' });
const durationMs = performance.now() - started;
if (run.status !== 0) throw new Error(run.stderr || `native core exited ${run.status}`);

const db = new Database(staging, { readonly: true });
try {
  const validation = validateNativeStaging(db, 'native-benchmark');
  const languages = db.prepare(
    'SELECT language, COUNT(*) AS files FROM native_files GROUP BY language ORDER BY language',
  ).all();
  const hottestCallFiles = db.prepare(`
    SELECT f.rel_path AS path, COUNT(*) AS calls
    FROM native_calls AS c
    JOIN native_files AS f ON f.id = c.file_id
    GROUP BY f.id
    ORDER BY calls DESC, f.rel_path
    LIMIT 10
  `).all();
  const edgeTypes = db.prepare(
    'SELECT type,COUNT(*) AS edges FROM native_edges GROUP BY type ORDER BY edges DESC,type',
  ).all();
  const edgeStrategies = db.prepare(
    'SELECT strategy,COUNT(*) AS edges FROM native_edges GROUP BY strategy ORDER BY edges DESC,strategy',
  ).all();
  const callDispatch = db.prepare(
    'SELECT dispatch_kind,COUNT(*) AS calls FROM native_calls GROUP BY dispatch_kind ORDER BY calls DESC,dispatch_kind',
  ).all();
  const duplicateEdges = db.prepare(`
    SELECT COALESCE(SUM(count - 1),0) AS duplicates FROM (
      SELECT COUNT(*) AS count FROM native_edges
      GROUP BY file_id,source_qualified_name,target_qualified_name,type,start_line,start_column
      HAVING COUNT(*) > 1
    )
  `).get().duplicates;
  const semanticHash = createHash('sha256');
  const fingerprintQueries = [
    'SELECT rel_path,language,sha256,size_bytes,status,partial_reasons_json FROM native_files ORDER BY rel_path',
    'SELECT f.rel_path,n.kind,n.name,n.qualified_name,n.start_line,n.end_line,n.is_exported,n.is_test,n.is_entry_point,n.properties_json FROM native_nodes n JOIN native_files f ON f.id=n.file_id ORDER BY f.rel_path,n.qualified_name',
    'SELECT f.rel_path,c.enclosing_qualified_name,c.callee_name,c.dispatch_kind,c.receiver_text,c.start_line,c.start_column,c.arguments_json FROM native_calls c JOIN native_files f ON f.id=c.file_id ORDER BY f.rel_path,c.enclosing_qualified_name,c.callee_name,c.start_line,c.start_column,c.id',
    'SELECT f.rel_path,i.local_name,i.imported_name,i.module_path,i.resolved_rel_path,i.start_line FROM native_imports i JOIN native_files f ON f.id=i.file_id ORDER BY f.rel_path,i.local_name,i.module_path,i.start_line,i.id',
    'SELECT f.rel_path,u.enclosing_qualified_name,u.referenced_name,u.start_line,u.start_column,u.is_write FROM native_usages u JOIN native_files f ON f.id=u.file_id ORDER BY f.rel_path,u.enclosing_qualified_name,u.referenced_name,u.is_write,u.start_line,u.start_column,u.id',
    'SELECT f.rel_path,e.source_qualified_name,e.target_qualified_name,e.type,e.start_line,e.start_column,e.confidence,e.strategy,e.evidence_json FROM native_edges e JOIN native_files f ON f.id=e.file_id ORDER BY f.rel_path,e.source_qualified_name,e.target_qualified_name,e.type,e.start_line,e.start_column,e.id',
  ];
  for (const query of fingerprintQueries) {
    for (const row of db.prepare(query).iterate()) semanticHash.update(JSON.stringify(row)).update('\n');
  }
  console.log(JSON.stringify({
    repository: repo,
    workers,
    duration_ms: Number(durationMs.toFixed(2)),
    files_per_second: Number((files.length / (durationMs / 1000)).toFixed(2)),
    validation,
    languages,
    hottest_call_files: hottestCallFiles,
    edge_types: edgeTypes,
    edge_strategies: edgeStrategies,
    call_dispatch: callDispatch,
    duplicate_edges_same_observation: duplicateEdges,
    semantic_sha256: semanticHash.digest('hex'),
    staging_bytes: fs.statSync(staging).size,
  }, null, 2));
} finally {
  db.close();
}
