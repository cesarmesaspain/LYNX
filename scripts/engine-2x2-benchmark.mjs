#!/usr/bin/env node
/**
 * Reproducible engine A/B: index two repositories with LYNX and Codebase Memory.
 *
 * Every cell gets an isolated cache. The report keeps raw stdout/stderr paths,
 * measures wall time and peak RSS (macOS /usr/bin/time), and reads only metrics
 * shared by both SQLite graph schemas. It intentionally does not rank engines by
 * node/edge volume alone.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

function parseArgs(argv) {
  const options = { workers: 2, out: path.resolve('benchmarks/results/engine-2x2.json') };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!key || argv[i + 1] === undefined) throw new Error(`Missing value for ${argv[i]}`);
    options[key] = argv[i + 1];
  }
  options.workers = options.workers === 'auto'
    ? null
    : Math.max(1, Number(options.workers) || 2);
  options.codebaseSingleThread = options.codebaseSingleThread === '1' || options.codebaseSingleThread === 'true';
  for (const required of ['lynxRepo', 'codebaseRepo', 'codebaseBin']) {
    if (!options[required]) throw new Error(`--${required.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} is required`);
    options[required] = path.resolve(options[required]);
  }
  options.out = path.resolve(options.out);
  return options;
}

function safeName(value) {
  return path.basename(value).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'repo';
}

function runTimed(command, args, env, cwd, artifactPrefix) {
  const startedAt = new Date().toISOString();
  const result = spawnSync('/usr/bin/time', ['-lp', command, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.writeFileSync(`${artifactPrefix}.stdout.log`, result.stdout || '');
  fs.writeFileSync(`${artifactPrefix}.stderr.log`, result.stderr || '');
  const real = result.stderr?.match(/^real\s+([\d.]+)/m);
  const rss = result.stderr?.match(/^\s*(\d+)\s+maximum resident set size/m);
  return {
    started_at: startedAt,
    exit_code: result.status,
    wall_time_s: real ? Number(real[1]) : null,
    peak_rss_bytes: rss ? Number(rss[1]) : null,
    stdout_log: path.basename(`${artifactPrefix}.stdout.log`),
    stderr_log: path.basename(`${artifactPrefix}.stderr.log`),
  };
}

function readTimed(artifactPrefix) {
  const stderrPath = `${artifactPrefix}.stderr.log`;
  const stderr = fs.readFileSync(stderrPath, 'utf8');
  const real = stderr.match(/^real\s+([\d.]+)/m);
  const rss = stderr.match(/^\s*(\d+)\s+maximum resident set size/m);
  if (!real || !rss) throw new Error(`Incomplete timing log: ${stderrPath}`);
  return {
    started_at: null,
    exit_code: 0,
    wall_time_s: Number(real[1]),
    peak_rss_bytes: Number(rss[1]),
    stdout_log: path.basename(`${artifactPrefix}.stdout.log`),
    stderr_log: path.basename(stderrPath),
  };
}

function graphMetrics(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const nodeColumns = db.prepare('PRAGMA table_info(nodes)').all().map(row => row.name);
    const labelColumn = nodeColumns.includes('kind') ? 'kind' : 'label';
    const scalar = (sql) => Number(Object.values(db.prepare(sql).get())[0]);
    const edgeRows = db.prepare('SELECT type, count(*) n FROM edges GROUP BY type ORDER BY n DESC').all();
    const nodeRows = db.prepare(`SELECT ${labelColumn} label, count(*) n FROM nodes GROUP BY ${labelColumn} ORDER BY n DESC`).all();
    const crossLanguageUsage = scalar(`
      SELECT count(*) FROM edges e
      JOIN nodes s ON s.id=e.source_id JOIN nodes t ON t.id=e.target_id
      WHERE e.type IN ('USAGE','READS','CALLS')
        AND (s.file_path LIKE '%.ts' OR s.file_path LIKE '%.tsx')
        AND (t.file_path LIKE '%.c' OR t.file_path LIKE '%.h')`);
    const sameStemCImplementations = scalar(`
      SELECT count(*) FROM nodes impl
      WHERE impl.${labelColumn} IN ('Function','Method') AND impl.file_path LIKE '%.c'
        AND EXISTS (SELECT 1 FROM nodes decl
          WHERE decl.name=impl.name AND decl.file_path LIKE '%.h')`);
    return {
      database_bytes: fs.statSync(dbPath).size,
      nodes: scalar('SELECT count(*) FROM nodes'),
      edges: scalar('SELECT count(*) FROM edges'),
      files: scalar(`SELECT count(*) FROM nodes WHERE ${labelColumn}='File'`),
      node_labels: Object.fromEntries(nodeRows.map(row => [row.label, Number(row.n)])),
      edge_types: Object.fromEntries(edgeRows.map(row => [row.type, Number(row.n)])),
      precision_probes: {
        typescript_to_c_edges: crossLanguageUsage,
        c_implementations_preserved_beside_header: sameStemCImplementations,
      },
    };
  } finally {
    db.close();
  }
}

function onlyGraphDb(directory) {
  const candidates = fs.readdirSync(directory)
    .filter(name => name.endsWith('.db') && name !== '_config.db')
    .map(name => path.join(directory, name));
  if (candidates.length !== 1) throw new Error(`Expected one graph DB in ${directory}, found ${candidates.length}`);
  return candidates[0];
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = path.dirname(options.out);
  fs.mkdirSync(outputDir, { recursive: true });
  const workRoot = options.reuseRoot
    ? path.resolve(options.reuseRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-engine-2x2-'));
  const lynxRoot = options.lynxRepo;
  const matrix = [];
  const repositories = [
    ['lynx', options.lynxRepo],
    ['codebase-memory', options.codebaseRepo],
  ];

  for (const [repoId, repoPath] of repositories) {
    const lynxHome = path.join(workRoot, `lynx-on-${repoId}`);
    const project = `ab-${safeName(repoId)}`;
    const lynxPrefix = path.join(outputDir, `lynx-on-${repoId}`);
    const lynxRun = options.reuseRoot
      ? readTimed(lynxPrefix)
      : runTimed(
          process.execPath,
          [path.join(lynxRoot, 'dist/cli.js'), 'index', repoPath, '--name', project, '--mode', 'full'],
          {
            LYNX_HOME: lynxHome,
            ...(options.workers === null ? {} : { LYNX_WORKERS: String(options.workers) }),
          },
          lynxRoot,
          lynxPrefix,
        );
    if (lynxRun.exit_code !== 0) throw new Error(`LYNX failed on ${repoId}; see ${lynxRun.stderr_log}`);
    matrix.push({ engine: 'lynx', repository: repoId, ...lynxRun,
      graph: graphMetrics(path.join(lynxHome, 'dbs', `${project}.db`)) });

    const cbmCache = path.join(workRoot, `codebase-on-${repoId}`);
    fs.mkdirSync(cbmCache, { recursive: true });
    const cbmPrefix = path.join(outputDir, `codebase-on-${repoId}`);
    const cbmRun = options.reuseRoot
      ? readTimed(cbmPrefix)
      : runTimed(
          options.codebaseBin,
          ['cli', 'index_repository', JSON.stringify({ repo_path: repoPath, mode: 'full' })],
          {
            CBM_CACHE_DIR: cbmCache,
            ...(options.codebaseSingleThread ? { CBM_INDEX_SINGLE_THREAD: '1' } : {}),
          },
          repoPath,
          cbmPrefix,
        );
    if (cbmRun.exit_code !== 0) throw new Error(`Codebase Memory failed on ${repoId}; see ${cbmRun.stderr_log}`);
    matrix.push({ engine: 'codebase-memory', repository: repoId, ...cbmRun,
      graph: graphMetrics(onlyGraphDb(cbmCache)) });
  }

  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    methodology: {
      design: '2 engines × 2 repositories; fresh isolated cache per cell',
      workers: options.workers,
      codebase_single_thread: options.codebaseSingleThread,
      ranking_warning: 'Raw node/edge counts measure coverage and noise together; precision probes and task oracles decide superiority.',
      repositories: Object.fromEntries(repositories.map(([id, value]) => [id, value])),
      binaries: { lynx: path.join(lynxRoot, 'dist/cli.js'), codebase_memory: options.codebaseBin },
    },
    matrix,
  };
  fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(options.out);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
