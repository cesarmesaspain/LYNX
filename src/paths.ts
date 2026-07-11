/*
 * paths.ts — Binary-safe path resolution for LYNX.
 *
 * CRITICAL: This module does NOT use import.meta.url at the top level
 * because pkg's v8 bytecode compiler cannot handle it and will fail
 * to include this file in the binary snapshot.
 *
 * Two root concepts:
 * - getProjectRoot(): real filesystem (for DB files, user output)
 * - getAssetRoot(): VFS /snapshot/ in pkg (for WASM, bundled files)
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

let _projectRoot: string | null = null;
let _assetRoot: string | null = null;
let _isPkg: boolean | null = null;

function findProjectRoot(): string {
  const entry = process.argv[1];
  if (entry) {
    let dir = path.resolve(path.dirname(entry));
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        return dir;
      }
      dir = path.dirname(dir);
    }
  }
  return process.cwd();
}

/**
 * Find the VFS root in pkg mode.
 * In pkg, the entry script is at /snapshot/<name>/dist/cli.js,
 * so we walk up to find package.json.
 */
function findAssetRoot(): string {
  const entry = process.argv[1];
  if (entry) {
    let dir = path.resolve(path.dirname(entry));
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        return dir;
      }
      dir = path.dirname(dir);
    }
  }
  // Fallback for pkg: the snapshot root uses the package name
  return '/snapshot/LYNX';
}

export function isPkg(): boolean {
  if (_isPkg === null) {
    _isPkg = !!(process as any).pkg;
  }
  return _isPkg;
}

/** Real filesystem root — for DB files, user-facing paths. */
export function getProjectRoot(): string {
  if (_projectRoot === null) {
    _projectRoot = isPkg()
      ? path.dirname(process.execPath)
      : findProjectRoot();
  }
  return _projectRoot;
}

/** Asset root — VFS in pkg mode, same as project root in dev. */
export function getAssetRoot(): string {
  if (_assetRoot === null) {
    _assetRoot = isPkg()
      ? findAssetRoot()
      : findProjectRoot();
  }
  return _assetRoot;
}

export function readAsset(relativePath: string): Buffer | null {
  try {
    return fs.readFileSync(path.join(getAssetRoot(), relativePath));
  } catch {
    return null;
  }
}

export function assetExists(relativePath: string): boolean {
  try {
    return fs.existsSync(path.join(getAssetRoot(), relativePath));
  } catch {
    return false;
  }
}

/** Resolve path to an asset file. Uses VFS root in pkg mode. */
export function resolveAssetPath(relativePath: string): string {
  return path.join(getAssetRoot(), relativePath);
}

// ── Native extractor binary ──────────────────────────────────────

let _nativeExtractorPath: string | null = null;

/**
 * Returns the path to the native C extractor binary.
 * In pkg mode, extracts it from the VFS to a temp file.
 * In dev mode, returns the path in the native/ directory.
 *
 * Returns null if the binary is not available (wrong platform, etc.).
 */
export function getNativeExtractorPath(): string | null {
  if (_nativeExtractorPath !== null) return _nativeExtractorPath || null;

  const assetRelPath = 'native/lynx_ts_extractor';

  if (isPkg()) {
    // In pkg, the binary is bundled as an asset in the VFS
    try {
      const vfsPath = path.join(getAssetRoot(), assetRelPath);
      if (!fs.existsSync(vfsPath)) {
        _nativeExtractorPath = '';
        return null;
      }
      // Copy to a temp file and make executable
      const tmpPath = path.join(os.tmpdir(), 'lynx_ts_extractor_' + process.pid);
      fs.copyFileSync(vfsPath, tmpPath);
      fs.chmodSync(tmpPath, 0o755);
      _nativeExtractorPath = tmpPath;
      return tmpPath;
    } catch {
      _nativeExtractorPath = '';
      return null;
    }
  }

  // Dev mode: check project root
  const devPath = path.join(getProjectRoot(), assetRelPath);
  if (fs.existsSync(devPath)) {
    _nativeExtractorPath = devPath;
    return devPath;
  }

  _nativeExtractorPath = '';
  return null;
}

/**
 * Clean up extracted temp files on shutdown.
 */
export function cleanupNativeExtractor(): void {
  if (_nativeExtractorPath && _nativeExtractorPath.startsWith(os.tmpdir())) {
    try { fs.unlinkSync(_nativeExtractorPath); } catch { /* ignore */ }
    _nativeExtractorPath = null;
  }
}
