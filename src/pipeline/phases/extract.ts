/*
 * extract.ts — Phase 2: Parse and extract definitions/calls/imports from files.
 *
 * Dispatches to the appropriate parser per file extension:
 * - native/tree-sitter/text extraction for 159 active language configs
 * - TypeScript compiler API for .ts/.tsx (richer type info)
 *
 * Async because tree-sitter WASM loads grammars asynchronously.
 * SHA256 incremental caching: skips files whose hash hasn't changed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { extractFile } from '../../extraction/extractor.js';
import { isSupportedFilePath } from '../../extraction/language-registry.js';
import { getNativeCorePath, getNativeExtractorPath, getProjectRoot } from '../../paths.js';
import { validateNativeStaging } from '../../native-core/staging.js';
import type { DiscoveredFile } from './discover.js';
import type { ExtractionResult } from '../../extraction/extractor.js';
import { baseModuleQn, buildModuleIdentityMap, moduleIdentityForPath } from '../../extraction/module-identity.js';

export interface ExtractionBatch {
  file: DiscoveredFile;
  result: ExtractionResult;
  sha256?: string;
  skipped?: boolean;
  nativeEdges?: NativeResolvedEdge[];
}

export interface NativeResolvedEdge {
  sourceQualifiedName: string;
  targetQualifiedName: string;
  type: 'CALLS' | 'READS' | 'WRITES';
  startLine: number;
  startColumn: number;
  confidence: number;
  strategy: string;
  evidence: Record<string, unknown>;
}

interface WorkerTask {
  id: number;
  file: DiscoveredFile;
  cachedHash?: string;
  moduleQn: string;
  project: string;
}

interface WorkerResult {
  id: number;
  file: DiscoveredFile;
  result: ExtractionResult;
  sha256: string;
  skipped?: boolean;
}

interface NativeResult extends WorkerResult {}

interface ProcessItem {
  file: DiscoveredFile;
  cachedHash?: string;
  ext: string;
  sourceHash?: string;
  moduleQn: string;
}

/**
 * Extract all discovered files in parallel batches.
 *
 * When fileHashMap is provided (incremental mode), files whose SHA256
 * matches the cached hash are skipped. Only supported files are processed.
 * Files are processed in parallel batches of 20 for maximum throughput.
 */
export async function extractAll(
  files: DiscoveredFile[],
  project: string,
  fileHashMap?: Map<string, string>
): Promise<ExtractionBatch[]> {
  const emptyResult: ExtractionResult = {
    nodes: [],
    calls: [],
    imports: [],
    usages: [],
    channels: [],
    throws: [],
    decorators: [],
    hasError: false,
    errorMsg: null,
    isTestFile: false,
    language: 'unknown',
  };

  const ordered: Array<ExtractionBatch | ProcessItem> = [];
  const toProcess: ProcessItem[] = [];
  const supportedFiles = files.filter((file) => isSupportedFilePath(file.relPath));
  const moduleIdentities = buildModuleIdentityMap(
    supportedFiles.map((file) => file.relPath),
  );

  for (const file of supportedFiles) {
    const ext = file.relPath.split('.').pop()?.toLowerCase() || '';
    const cachedHash = fileHashMap?.get(file.relPath);
    const moduleQn = moduleIdentityForPath(moduleIdentities, file.relPath);
    let sourceHash: string | undefined;
    if (cachedHash) {
      try {
        const source = fs.readFileSync(file.absPath, 'utf-8');
        sourceHash = createHash('sha256').update(source).digest('hex');
        if (cachedHash === sourceHash) {
          ordered.push({ file, result: emptyResult, sha256: sourceHash, skipped: true });
          continue;
        }
      } catch {
        // Let the extractor report the read error in the normal path.
      }
    }
    const item: ProcessItem = { file, cachedHash, ext, sourceHash, moduleQn };
    ordered.push(item);
    toProcess.push(item);
  }

  const coreResults = await extractNativeCoreFiles(toProcess, project);
  const nativeResults = await extractNativeLargeFiles(toProcess, project);
  for (const [index, result] of coreResults) nativeResults.set(index, result);

  const remaining = toProcess.filter((_, index) => !nativeResults.has(index));
  const workerResults = await extractWithWorkers(remaining, project, emptyResult);
  let workerIndex = 0;
  const processed: ExtractionBatch[] = [];
  for (let i = 0; i < toProcess.length; i++) {
    const native = nativeResults.get(i);
    if (native) processed.push(native);
    else processed.push(workerResults[workerIndex++]);
  }

  let processedIndex = 0;
  return ordered.map((entry) => {
    if ('result' in entry) return entry;
    return processed[processedIndex++];
  });
}

async function extractNativeCoreFiles(
  toProcess: ProcessItem[],
  project: string,
): Promise<Map<number, ExtractionBatch>> {
  if (process.env.LYNX_DISABLE_NATIVE === '1' || process.env.LYNX_DISABLE_NATIVE_CORE === '1') {
    return new Map();
  }
  const binary = getNativeCorePath();
  const tasks = toProcess
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => ['c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'].includes(item.ext));
  if (!binary || tasks.length === 0) return new Map();

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-pipeline-'));
  const manifest = path.join(temp, 'manifest.tsv');
  const stagingPath = path.join(temp, 'staging.db');
  const relativeDirectory = path.dirname(tasks[0].item.file.relPath);
  const repositoryRoot = path.resolve(
    path.dirname(tasks[0].item.file.absPath),
    ...Array(relativeDirectory === '.' ? 0 : relativeDirectory.split('/').length).fill('..'),
  );
  fs.writeFileSync(manifest, tasks.map(({ item }) => {
    const language = ['cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'].includes(item.ext) ? 'cpp' : 'c';
    return `${language}\t${item.file.relPath}\t${item.file.absPath}`;
  }).join('\n') + '\n');

  try {
    const workers = Math.max(1, Math.min(10, os.availableParallelism?.() || os.cpus().length || 4, tasks.length));
    await runProcess(binary, [project, repositoryRoot, manifest, stagingPath, String(workers), 'full']);
    const db = new Database(stagingPath, { readonly: true });
    try {
      const validation = validateNativeStaging(db, project);
      if (!validation.valid) throw new Error(validation.errors.join('; '));
      const result = new Map<number, ExtractionBatch>();
      for (const { item, index } of tasks) {
        const file = db.prepare('SELECT id, language, partial_reasons_json FROM native_files WHERE rel_path = ?')
          .get(item.file.relPath) as { id: number; language: string; partial_reasons_json: string } | undefined;
        if (!file) continue;
        const nodes = (db.prepare('SELECT * FROM native_nodes WHERE file_id = ? ORDER BY id').all(file.id) as Array<Record<string, unknown>>)
          .map((row) => nativeNode(project, item.file.relPath, row));
        const calls = (db.prepare('SELECT * FROM native_calls WHERE file_id = ? ORDER BY id').all(file.id) as Array<Record<string, unknown>>)
          .map((row) => ({ calleeName: String(row.callee_name), enclosingFuncQn: String(row.enclosing_qualified_name), args: [], startLine: Number(row.start_line), loopDepth: 0 }));
        const imports = (db.prepare('SELECT * FROM native_imports WHERE file_id = ? ORDER BY id').all(file.id) as Array<Record<string, unknown>>)
          .map((row) => ({ localName: String(row.local_name), modulePath: String(row.module_path), startLine: Number(row.start_line) }));
        const usages = (db.prepare('SELECT * FROM native_usages WHERE file_id = ? ORDER BY id').all(file.id) as Array<Record<string, unknown>>)
          .map((row) => ({ refName: String(row.referenced_name), enclosingFuncQn: String(row.enclosing_qualified_name), startLine: Number(row.start_line), isWrite: Number(row.is_write) === 1 }));
        const nativeEdges = (db.prepare('SELECT * FROM native_edges WHERE file_id = ? ORDER BY id').all(file.id) as Array<Record<string, unknown>>)
          .map((row): NativeResolvedEdge => ({
            sourceQualifiedName: String(row.source_qualified_name), targetQualifiedName: String(row.target_qualified_name),
            type: String(row.type) as NativeResolvedEdge['type'], startLine: Number(row.start_line),
            startColumn: Number(row.start_column), confidence: Number(row.confidence), strategy: String(row.strategy),
            evidence: JSON.parse(String(row.evidence_json || '{}')) as Record<string, unknown>,
          }));
        result.set(index, {
          file: item.file,
          sha256: item.sourceHash || String((db.prepare('SELECT sha256 FROM native_files WHERE id = ?').get(file.id) as { sha256: string }).sha256),
          result: { nodes, calls, imports, usages, channels: [], throws: [], decorators: [], hasError: false,
            errorMsg: null, isTestFile: /(^|\/)(test|tests|spec)(\/|_|\.)/i.test(item.file.relPath),
            language: file.language, partialReasons: JSON.parse(file.partial_reasons_json) as string[] },
          nativeEdges,
        });
      }
      return result;
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('[lynx] Native structural core failed; using safe fallback:', error instanceof Error ? error.message : String(error));
    return new Map();
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const errors: Buffer[] = [];
    let settled = false;
    const timeoutMs = Math.max(1_000, Number(process.env.LYNX_NATIVE_CORE_TIMEOUT_MS || 5 * 60_000));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`native core timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    child.stderr.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(errors).toString('utf8') || `native core ${signal || `exit ${code}`}`));
    });
  });
}

function nativeNode(project: string, filePath: string, row: Record<string, unknown>): ExtractionResult['nodes'][number] {
  const rawKind = String(row.kind);
  const kind = rawKind === 'Method' || rawKind === 'Constructor' || rawKind === 'Destructor' ? 'Method'
    : rawKind === 'Class' || rawKind === 'Struct' || rawKind === 'Union' ? 'Class'
    : rawKind === 'Enum' ? 'Enum'
    : rawKind === 'Namespace' ? 'Module'
    : rawKind === 'TypeAlias' ? 'Type'
    : rawKind === 'Macro' ? 'Macro'
    : rawKind === 'Function' ? 'Function' : 'Variable';
  const base = { project, kind, name: String(row.name), qualifiedName: String(row.qualified_name), filePath,
    startLine: Number(row.start_line), endLine: Number(row.end_line), isExported: Number(row.is_exported) === 1,
    isTest: Number(row.is_test) === 1, isEntryPoint: Number(row.is_entry_point) === 1 };
  if (kind === 'Function') return { ...base, kind, signature: null, returnType: null, paramNames: [], cyclomaticComplexity: 1,
    cognitiveComplexity: 0, lineCount: Math.max(1, base.endLine - base.startLine + 1), loopCount: 0, loopDepth: 0,
    transitiveLoopDepth: 0, linearScanInLoop: 0, allocInLoop: 0, recursive: false };
  if (kind === 'Method') return { ...base, kind, parentClass: base.qualifiedName.split('.').slice(0, -1).join('.'), signature: null,
    returnType: null, paramNames: [], cyclomaticComplexity: 1, cognitiveComplexity: 0,
    lineCount: Math.max(1, base.endLine - base.startLine + 1) };
  if (kind === 'Class') return { ...base, kind, baseClasses: [], lineCount: Math.max(1, base.endLine - base.startLine + 1), cyclomaticComplexity: 1 };
  if (kind === 'Enum') return { ...base, kind, members: [] };
  if (kind === 'Module') return { ...base, kind, lineCount: Math.max(1, base.endLine - base.startLine + 1) };
  if (kind === 'Type' || kind === 'Macro') return { ...base, kind };
  return { ...base, kind: 'Variable', typeAnnotation: rawKind };
}

async function extractNativeLargeFiles(
  toProcess: ProcessItem[],
  project: string
): Promise<Map<number, ExtractionBatch>> {
  // The native TypeScript scanner is deliberately opt-in until it emits a
  // complete call graph.  It currently extracts definitions/imports quickly
  // but cannot assign local calls to their enclosing function, which creates
  // indexed symbols with missing CALLS edges. Correct graph connectivity is
  // more important than this optional fast path.
  if (process.env.LYNX_DISABLE_NATIVE === '1' || process.env.LYNX_ENABLE_NATIVE_EXTRACTOR !== '1') {
    return new Map();
  }

  const binaryPath = getNativeExtractorPath();
  if (!binaryPath) {
    return new Map();
  }

  const tasks = toProcess
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.ext === 'ts' || item.ext === 'tsx')
    .map(({ item, index }) => ({
      id: index,
      project,
      relPath: item.file.relPath,
      absPath: item.file.absPath,
      cachedHash: item.cachedHash,
    }));

  if (tasks.length === 0) return new Map();

  try {
    const shardCount = nativeShardCount(tasks.length);
    const shards: typeof tasks[] = Array.from({ length: shardCount }, () => []);
    for (let i = 0; i < tasks.length; i++) {
      shards[i % shardCount].push(tasks[i]);
    }

    const outputs = await Promise.all(
      shards.filter((shard) => shard.length > 0)
        .map((shard) => runNativeExtractor(binaryPath, JSON.stringify(shard)))
    );
    const parsed = outputs.flatMap((stdout) => JSON.parse(stdout) as NativeResult[]);
    const map = new Map<number, ExtractionBatch>();
    for (const result of parsed) {
      const original = toProcess[result.id];
      if (!original || result.result.hasError) continue;
      restoreNativeEntryPointFlags(result.result.nodes, original.file.relPath);
      // The native extractor emits compact method nodes. Restore class scope here
      // so same-named methods in different classes never share a qualified name.
      const classes = result.result.nodes.filter(node => node.kind === 'Class');
      for (const node of result.result.nodes) {
        if (node.kind !== 'Method') continue;
        const owner = classes.find(candidate =>
          candidate.startLine <= node.startLine && candidate.endLine >= node.endLine,
        );
        if (owner) node.qualifiedName = `${owner.qualifiedName}.${node.name}`;
      }
      map.set(result.id, {
        file: original.file,
        result: {
          ...result.result,
          throws: result.result.throws || [],
          decorators: result.result.decorators || [],
        },
        sha256: original.sourceHash || result.sha256,
        skipped: result.skipped,
      });
    }
    return map;
  } catch (err) {
    console.error('[lynx] Native extractor failed:', (err as Error).message || String(err));
    return new Map();
  }
}

/** Keep native C extractor output aligned with the tree-sitter extractor. */
export function restoreNativeEntryPointFlags(nodes: ExtractionResult['nodes'], relPath: string): void {
  const conventionalIndex = relPath.endsWith('index.ts') || relPath.endsWith('index.tsx');
  if (!conventionalIndex) return;
  for (const node of nodes) {
    if (node.kind === 'Module') node.isEntryPoint = true;
  }
}

function nativeShardCount(taskCount: number): number {
  const requested = Number(process.env.LYNX_NATIVE_SHARDS || 0);
  if (requested > 0) return Math.max(1, Math.min(requested, taskCount));
  const parallelism = os.availableParallelism?.() || os.cpus().length || 4;
  return Math.max(1, Math.min(8, parallelism, Math.ceil(taskCount / 64)));
}

function runNativeExtractor(binaryPath: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errChunks.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf-8'));
      else reject(new Error(Buffer.concat(errChunks).toString('utf-8') || `native extractor exited ${code}`));
    });
    child.stdin.end(input);
  });
}

async function extractWithWorkers(
  toProcess: ProcessItem[],
  project: string,
  emptyResult: ExtractionResult
): Promise<ExtractionBatch[]> {
  if (toProcess.length === 0) return [];

  // The packaged CLI keeps extraction deterministic and avoids resolving a
  // worker module from pkg's virtual filesystem.
  if ((process as NodeJS.Process & { pkg?: unknown }).pkg) {
    return extractDirect(toProcess, project, emptyResult);
  }

  const workerPath = path.join(getProjectRoot(), 'dist', 'pipeline', 'phases', 'extract-worker.js');
  const directThreshold = Number(process.env.LYNX_DIRECT_THRESHOLD || 16);
  if (!fs.existsSync(workerPath) || toProcess.length < directThreshold) {
    return extractDirect(toProcess, project, emptyResult);
  }

  const requestedWorkers = Number(process.env.LYNX_WORKERS || 0);
  const workerCount = Math.max(
    1,
    Math.min(
      requestedWorkers > 0 ? requestedWorkers : (os.availableParallelism?.() || os.cpus().length || 4),
      10,
      toProcess.length
    )
  );
  const results = new Array<ExtractionBatch>(toProcess.length);
  let nextTask = 0;
  let completed = 0;

  return await new Promise((resolve) => {
    const workers: Worker[] = [];

    const finishWorker = (worker: Worker): void => {
      worker.terminate().catch(() => undefined);
    };

    const assign = (worker: Worker): void => {
      if (nextTask >= toProcess.length) {
        if (completed >= toProcess.length) {
          for (const w of workers) finishWorker(w);
          resolve(results);
        }
        return;
      }

      const id = nextTask++;
      const item = toProcess[id];
      const task: WorkerTask = {
        id,
        file: item.file,
        cachedHash: item.cachedHash,
        moduleQn: item.moduleQn,
        project,
      };
      worker.postMessage(task);
    };

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(workerPath);
      workers.push(worker);

      worker.on('message', (message: WorkerResult) => {
        results[message.id] = {
          file: message.file,
          result: message.result,
          sha256: message.sha256,
          skipped: message.skipped,
        };
        completed++;
        assign(worker);
      });

      worker.on('error', () => {
        completed++;
        assign(worker);
      });

      assign(worker);
    }
  });
}

async function extractDirect(
  toProcess: ProcessItem[],
  project: string,
  emptyResult: ExtractionResult
): Promise<ExtractionBatch[]> {
  const results: ExtractionBatch[] = [];
  for (const { file, cachedHash } of toProcess) {
    const moduleQn = fileToModuleQn(file.relPath);
    try {
      const source = fs.readFileSync(file.absPath, 'utf-8');
      const sha256 = createHash('sha256').update(source).digest('hex');
      if (cachedHash && cachedHash === sha256) {
        results.push({ file, result: emptyResult, sha256, skipped: true });
        continue;
      }
      const result = await extractFile(source, project, file.relPath, moduleQn);
      results.push({ file, result, sha256 });
    } catch {
      results.push({
        file,
        sha256: '',
        result: { ...emptyResult, hasError: true, errorMsg: 'extraction failed' },
      });
    }
  }
  return results;
}

/**
 * Convert file path to module qualified name.
 * src/lib/ops/director.ts → lib.ops.director
 */
export function fileToModuleQn(relPath: string): string {
  const withoutExt = relPath.replace(/\.[^.]+$/, '');
  let qn = withoutExt.replace(/\//g, '.').replace(/\\/g, '.');
  const parts = qn.split('.');
  if (parts[parts.length - 1] === 'index') {
    parts.pop();
  }
  qn = parts.join('.');
  if (qn.startsWith('src.')) {
    qn = qn.substring(4);
  }
  return qn;
}
