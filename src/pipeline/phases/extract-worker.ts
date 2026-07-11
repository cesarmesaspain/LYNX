import { parentPort } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { extractFile } from '../../extraction/extractor.js';

parentPort?.on('message', async (task) => {
  const moduleQn = fileToModuleQn(task.file.relPath);
  try {
    const source = fs.readFileSync(task.file.absPath, 'utf-8');
    const sha256 = crypto.createHash('sha256').update(source).digest('hex');
    if (task.cachedHash && task.cachedHash === sha256) {
      parentPort?.postMessage({
        id: task.id,
        file: task.file,
        result: {
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
        },
        sha256,
        skipped: true,
      });
      return;
    }

    const result = await extractFile(source, task.project, task.file.relPath, moduleQn);
    parentPort?.postMessage({ id: task.id, file: task.file, result, sha256 });
  } catch (err) {
    parentPort?.postMessage({
      id: task.id,
      file: task.file,
      sha256: '',
      result: {
        nodes: [],
        calls: [],
        imports: [],
        usages: [],
        channels: [],
        throws: [],
        decorators: [],
        hasError: true,
        errorMsg: err instanceof Error ? err.message : 'extraction failed',
        isTestFile: false,
        language: 'unknown',
      },
    });
  }
});

function fileToModuleQn(relPath: string): string {
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
