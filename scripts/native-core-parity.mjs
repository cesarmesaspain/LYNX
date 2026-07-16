#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { validateNativeStaging } from '../dist/native-core/staging.js';

const root = path.resolve(import.meta.dirname, '..');
const repo = path.resolve(process.argv[2] || '.');
const canonicalPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(os.homedir(), '.lynx', 'dbs', path.basename(repo) + '.db');
const workers = Math.max(1, Number(process.argv[4]) || os.availableParallelism());
const outputPath = process.argv[5] ? path.resolve(process.argv[5]) : null;
const competitorPath = process.argv[6] ? path.resolve(process.argv[6]) : null;
if (!fs.existsSync(canonicalPath)) throw new Error(`Canonical database not found: ${canonicalPath}`);
if (competitorPath && !fs.existsSync(competitorPath)) throw new Error(`Competitor database not found: ${competitorPath}`);

const extensions = new Map([
  ['.c', 'c'], ['.h', 'c'], ['.cc', 'cpp'], ['.cpp', 'cpp'],
  ['.cxx', 'cpp'], ['.hh', 'cpp'], ['.hpp', 'cpp'], ['.hxx', 'cpp'],
]);
const ignored = new Set(['.git', 'node_modules', 'build', 'dist', 'vendor', 'vendored', '.cache']);
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-parity-'));
const manifest = path.join(work, 'manifest.tsv');
const stagingPath = path.join(work, 'staging.db');
fs.writeFileSync(manifest, `${files.map((file) =>
  `${file.language}\t${file.relative}\t${file.absolute}`).join('\n')}\n`);
const run = spawnSync(path.join(root, 'native/lynx_native_core'), [
  'native-parity', repo, manifest, stagingPath, String(workers), 'full',
], { cwd: root, encoding: 'utf8' });
if (run.status !== 0) throw new Error(run.stderr || `native core exited ${run.status}`);

function family(kind) {
  if (['Function', 'Method', 'Constructor', 'Destructor'].includes(kind)) return 'callable';
  if (['Class', 'Struct', 'Union', 'TypeAlias', 'Enum'].includes(kind)) return 'type';
  if (['Variable', 'FunctionPointer', 'Field', 'EnumMember'].includes(kind)) return 'value';
  if (kind === 'Namespace') return 'namespace';
  if (kind === 'Macro') return 'macro';
  return null;
}

function summarize(rows) {
  const result = {};
  for (const row of rows) result[row.family] = (result[row.family] || 0) + 1;
  return result;
}

function topFiles(rows, limit = 20) {
  const counts = new Map();
  for (const row of rows) counts.set(row.file_path, (counts.get(row.file_path) || 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit).map(([file_path, count]) => ({ file_path, count }));
}

function key(row) {
  return `${row.file_path}\0${row.family}\0${row.name}\0${row.start_line}`;
}

function identityKey(row) {
  return `${row.file_path}\0${row.family}\0${row.name}`;
}

function compareReference(referenceRows, nativeRows) {
  const nativeKeys = new Set(nativeRows.map(key));
  const nativeIdentities = new Set(nativeRows.map(identityKey));
  const matched = referenceRows.filter((row) => nativeKeys.has(key(row)));
  const referenceOnly = referenceRows.filter((row) => !nativeKeys.has(key(row)));
  const identityOnly = referenceRows.filter((row) => !nativeIdentities.has(identityKey(row)));
  const families = [...new Set([...referenceRows, ...nativeRows].map((row) => row.family))].sort();
  return {
    totals: { reference: referenceRows.length, native: nativeRows.length, matched: matched.length, reference_only: referenceOnly.length },
    by_family: Object.fromEntries(families.map((name) => {
      const reference = referenceRows.filter((row) => row.family === name).length;
      const native = nativeRows.filter((row) => row.family === name).length;
      const exact = matched.filter((row) => row.family === name).length;
      const identity = referenceRows.filter(
        (row) => row.family === name && nativeIdentities.has(identityKey(row)),
      ).length;
      return [name, {
        reference, native, exact, identity_ignoring_line: identity,
        reference_recall: reference ? Number((exact / reference).toFixed(4)) : null,
      }];
    })),
    reference_only_sample: referenceOnly.slice(0, 50),
    identity_only_sample: identityOnly.slice(0, 50),
    identity_gap_nearby: identityOnly.slice(0, 50).map((gap) => ({
      gap,
      native_same_file_line: nativeRows.filter(
        (row) => row.file_path === gap.file_path && Math.abs(row.start_line - gap.start_line) <= 1,
      ).slice(0, 10),
    })),
    reference_callable_gap_files: topFiles(referenceOnly.filter((row) => row.family === 'callable')),
  };
}

function relationKey(row) {
  return `${row.source_file}\0${row.source_name}\0${row.target_file}\0${row.target_name}\0${row.type}`;
}

function compareRelationships(referenceRows, nativeRows) {
  const reference = new Map(referenceRows.map((row) => [relationKey(row), row]));
  const native = new Map(nativeRows.map((row) => [relationKey(row), row]));
  const types = [...new Set([...referenceRows, ...nativeRows].map((row) => row.type))].sort();
  return {
    totals: {
      reference: reference.size,
      native: native.size,
      matched: [...reference.keys()].filter((key) => native.has(key)).length,
      reference_only: [...reference.keys()].filter((key) => !native.has(key)).length,
      native_only: [...native.keys()].filter((key) => !reference.has(key)).length,
    },
    by_type: Object.fromEntries(types.map((type) => {
      const referenceKeys = new Set(referenceRows.filter((row) => row.type === type).map(relationKey));
      const nativeKeys = new Set(nativeRows.filter((row) => row.type === type).map(relationKey));
      const matched = [...referenceKeys].filter((key) => nativeKeys.has(key)).length;
      return [type, {
        reference: referenceKeys.size,
        native: nativeKeys.size,
        matched,
        reference_recall: referenceKeys.size ? Number((matched / referenceKeys.size).toFixed(4)) : null,
        native_agreement: nativeKeys.size ? Number((matched / nativeKeys.size).toFixed(4)) : null,
      }];
    })),
    reference_only_sample: [...reference.entries()].filter(([key]) => !native.has(key)).slice(0, 50).map(([, row]) => row),
    native_only_sample: [...native.entries()].filter(([key]) => !reference.has(key)).slice(0, 50).map(([, row]) => row),
  };
}

const nativeDb = new Database(stagingPath, { readonly: true });
const canonicalDb = new Database(canonicalPath, { readonly: true });
const competitorDb = competitorPath ? new Database(competitorPath, { readonly: true }) : null;
try {
  const validation = validateNativeStaging(nativeDb, 'native-parity');
  if (!validation.valid) throw new Error(validation.errors.join('; '));
  const nativeRows = nativeDb.prepare(`
    SELECT f.rel_path AS file_path,n.kind,n.name,n.start_line,n.qualified_name
    FROM native_nodes n JOIN native_files f ON f.id=n.file_id
    ORDER BY f.rel_path,n.start_line,n.kind,n.name
  `).all().map((row) => ({ ...row, family: family(row.kind) })).filter((row) => row.family);
  const canonicalRows = canonicalDb.prepare(`
    SELECT file_path,kind,name,start_line,qualified_name
    FROM nodes WHERE kind NOT IN ('File','Module')
      AND (file_path LIKE '%.c' OR file_path LIKE '%.h' OR file_path LIKE '%.cc' OR
           file_path LIKE '%.cpp' OR file_path LIKE '%.cxx' OR file_path LIKE '%.hh' OR
           file_path LIKE '%.hpp' OR file_path LIKE '%.hxx')
    ORDER BY file_path,start_line,kind,name
  `).all().map((row) => ({ ...row, family: family(row.kind) })).filter((row) => row.family);
  const competitorRows = competitorDb ? competitorDb.prepare(`
    SELECT file_path,label AS kind,name,start_line,qualified_name
    FROM nodes WHERE label NOT IN ('File','Module')
      AND (file_path LIKE '%.c' OR file_path LIKE '%.h' OR file_path LIKE '%.cc' OR
           file_path LIKE '%.cpp' OR file_path LIKE '%.cxx' OR file_path LIKE '%.hh' OR
           file_path LIKE '%.hpp' OR file_path LIKE '%.hxx')
    ORDER BY file_path,start_line,label,name
  `).all().map((row) => ({ ...row, family: family(row.kind) })).filter((row) => row.family) : [];
  const nativeRelations = nativeDb.prepare(`
    SELECT sf.rel_path AS source_file,s.name AS source_name,
           tf.rel_path AS target_file,t.name AS target_name,e.type,e.strategy,e.confidence
    FROM native_edges e
    JOIN native_nodes s ON s.qualified_name=e.source_qualified_name
    JOIN native_files sf ON sf.id=s.file_id
    JOIN native_nodes t ON t.qualified_name=e.target_qualified_name
    JOIN native_files tf ON tf.id=t.file_id
    WHERE e.type IN ('CALLS','READS','WRITES')
    ORDER BY source_file,source_name,target_file,target_name,e.type
  `).all();
  const canonicalRelations = canonicalDb.prepare(`
    SELECT s.file_path AS source_file,s.name AS source_name,
           t.file_path AS target_file,t.name AS target_name,e.type
    FROM edges e JOIN nodes s ON s.id=e.source_id JOIN nodes t ON t.id=e.target_id
    WHERE e.type IN ('CALLS','READS','WRITES')
      AND (s.file_path LIKE '%.c' OR s.file_path LIKE '%.h' OR s.file_path LIKE '%.cc' OR s.file_path LIKE '%.cpp')
      AND (t.file_path LIKE '%.c' OR t.file_path LIKE '%.h' OR t.file_path LIKE '%.cc' OR t.file_path LIKE '%.cpp')
    ORDER BY source_file,source_name,target_file,target_name,e.type
  `).all();
  const competitorRelations = competitorDb ? competitorDb.prepare(`
    SELECT s.file_path AS source_file,s.name AS source_name,
           t.file_path AS target_file,t.name AS target_name,e.type
    FROM edges e JOIN nodes s ON s.id=e.source_id JOIN nodes t ON t.id=e.target_id
    WHERE e.type IN ('CALLS','READS','WRITES')
      AND (s.file_path LIKE '%.c' OR s.file_path LIKE '%.h' OR s.file_path LIKE '%.cc' OR s.file_path LIKE '%.cpp')
      AND (t.file_path LIKE '%.c' OR t.file_path LIKE '%.h' OR t.file_path LIKE '%.cc' OR t.file_path LIKE '%.cpp')
    ORDER BY source_file,source_name,target_file,target_name,e.type
  `).all() : [];

  const nativeKeys = new Set(nativeRows.map(key));
  const canonicalKeys = new Set(canonicalRows.map(key));
  const nativeIdentities = new Set(nativeRows.map(identityKey));
  const matchedCanonical = canonicalRows.filter((row) => nativeKeys.has(key(row)));
  const canonicalOnly = canonicalRows.filter((row) => !nativeKeys.has(key(row)));
  const nativeOnly = nativeRows.filter((row) => !canonicalKeys.has(key(row)));
  const families = [...new Set([...nativeRows, ...canonicalRows].map((row) => row.family))].sort();
  const agreement = Object.fromEntries(families.map((name) => {
    const canonicalCount = canonicalRows.filter((row) => row.family === name).length;
    const nativeCount = nativeRows.filter((row) => row.family === name).length;
    const matched = matchedCanonical.filter((row) => row.family === name).length;
    const identityMatched = canonicalRows.filter(
      (row) => row.family === name && nativeIdentities.has(identityKey(row)),
    ).length;
    return [name, {
      canonical: canonicalCount,
      native: nativeCount,
      matched,
      identity_matched_ignoring_line: identityMatched,
      canonical_recall: canonicalCount ? Number((matched / canonicalCount).toFixed(4)) : null,
      identity_recall_ignoring_line: canonicalCount ? Number((identityMatched / canonicalCount).toFixed(4)) : null,
      native_agreement: nativeCount ? Number((matched / nativeCount).toFixed(4)) : null,
    }];
  }));
  const report = {
    schema_version: 1,
    repository: repo,
    canonical_database: canonicalPath,
    workers,
    native_validation: validation,
    warning: 'Native-only symbols are coverage candidates, not automatically correct. Canonical-only symbols are gaps or identity disagreements requiring source-level adjudication.',
    totals: {
      canonical: canonicalRows.length,
      native: nativeRows.length,
      matched: matchedCanonical.length,
      canonical_only: canonicalOnly.length,
      native_only: nativeOnly.length,
    },
    by_family: agreement,
    canonical_only_by_family: summarize(canonicalOnly),
    native_only_by_family: summarize(nativeOnly),
    canonical_callable_gaps_by_extension: Object.fromEntries(Object.entries(
      canonicalOnly.filter((row) => row.family === 'callable').reduce((counts, row) => {
        const extension = path.extname(row.file_path) || '(none)';
        counts[extension] = (counts[extension] || 0) + 1;
        return counts;
      }, {}),
    ).sort((left, right) => right[1] - left[1])),
    canonical_callable_gap_files: topFiles(canonicalOnly.filter((row) => row.family === 'callable')),
    native_callable_gap_files: topFiles(nativeOnly.filter((row) => row.family === 'callable')),
    canonical_only_sample: canonicalOnly.slice(0, 50),
    native_only_sample: nativeOnly.slice(0, 50),
    canonical_callable_only_sample: canonicalOnly.filter((row) => row.family === 'callable').slice(0, 50),
    native_callable_only_sample: nativeOnly.filter((row) => row.family === 'callable').slice(0, 50),
    competitor: competitorDb ? {
      database: competitorPath,
      ...compareReference(competitorRows, nativeRows),
    } : null,
    relationships: {
      canonical: compareRelationships(canonicalRelations, nativeRelations),
      competitor: competitorDb ? compareRelationships(competitorRelations, nativeRelations) : null,
    },
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, serialized);
    console.log(outputPath);
  } else {
    process.stdout.write(serialized);
  }
} finally {
  nativeDb.close();
  canonicalDb.close();
  competitorDb?.close();
  fs.rmSync(work, { recursive: true, force: true });
}
