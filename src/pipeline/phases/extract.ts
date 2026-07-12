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
import { extractFile } from '../../extraction/extractor.js';
import { isSupportedFilePath } from '../../extraction/language-registry.js';
import { getNativeExtractorPath, getProjectRoot } from '../../paths.js';
import type { DiscoveredFile } from './discover.js';
import type { ExtractionResult } from '../../extraction/extractor.js';

export interface ExtractionBatch {
  file: DiscoveredFile;
  result: ExtractionResult;
  sha256?: string;
  skipped?: boolean;
}

interface WorkerTask {
  id: number;
  file: DiscoveredFile;
  cachedHash?: string;
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

  for (const file of files) {
    const ext = file.relPath.split('.').pop()?.toLowerCase() || '';
    if (!isSupportedFilePath(file.relPath)) continue;
    const cachedHash = fileHashMap?.get(file.relPath);
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

    const item: ProcessItem = { file, cachedHash, ext, sourceHash };
    ordered.push(item);
    toProcess.push(item);
  }

  const nativeResults = await extractNativeLargeFiles(toProcess, project);

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

async function extractNativeLargeFiles(
  toProcess: ProcessItem[],
  project: string
): Promise<Map<number, ExtractionBatch>> {
  if (process.env.LYNX_DISABLE_NATIVE === '1') {
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
