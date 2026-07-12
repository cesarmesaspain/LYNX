#!/usr/bin/env node
/*
 * build-native-extractor.js — Compile the native C extractor for TS/TSX.
 *
 * Called before pkg bundling to ensure the binary exists and is
 * compiled for the target platform.
 *
 * In pkg, the binary is embedded as an asset and extracted to a temp
 * file at runtime. This script ensures it's compiled before packaging.
 *
 * Usage:
 *   node scripts/build-native-extractor.js              # compile for current platform
 *   node scripts/build-native-extractor.js --target darwin-arm64  # cross-compile hint
 *   node scripts/build-native-extractor.js --all         # try to compile all platform variants
 *
 * Cross-compilation:
 *   When building for a different platform than the host, you need
 *   cross-compilers installed. Set LYNX_NATIVE_EXTRACTOR_PATH at
 *   runtime to point to a precompiled binary if cross-compilation
 *   isn't available.
 */

import { execSync } from 'node:child_process';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { platform, arch } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'native', 'lynx_ts_extractor.c');
const NATIVE_DIR = join(ROOT, 'native');

const currentPlatform = platform();
const currentArch = arch();

// Parse --target flag
const args = process.argv.slice(2);
const targetArg = args.find(a => a.startsWith('--target='));
const buildAll = args.includes('--all');
const targetStr = targetArg ? targetArg.split('=')[1] : `${currentPlatform}-${currentArch}`;

console.log(`[build-native-extractor] Host: ${currentPlatform}-${currentArch}`);
console.log(`[build-native-extractor] Target: ${targetStr}`);

if (!existsSync(SRC)) {
  console.log('[build-native-extractor] Native extractor source not found — skipping.');
  process.exit(0);
}

// Platform triplets we can build for
const TARGETS = {
  'darwin-arm64': { cc: 'clang' },
  'darwin-x64':   { cc: 'clang', flags: '-target x86_64-apple-macos' },
  'linux-x64':    { cc: 'gcc' },
  'linux-arm64':  { cc: 'aarch64-linux-gnu-gcc' },
  'win-x64':      { cc: 'x86_64-w64-mingw32-gcc' },
};

function buildFor(target, outputName) {
  const t = TARGETS[target];
  if (!t) {
    console.log(`[build-native-extractor] Unknown target "${target}" — skipping.`);
    return false;
  }

  const dst = join(NATIVE_DIR, outputName);

  // Remove previous binary
  try { unlinkSync(dst); } catch { /* didn't exist */ }

  const cmd = `${t.cc} -O3 ${t.flags || ''} "${SRC}" -o "${dst}"`.replace(/\s+/g, ' ').trim();
  try {
    execSync(cmd, { stdio: 'inherit', cwd: ROOT });
    console.log(`[build-native-extractor] Compiled: ${dst}`);
    return true;
  } catch (err) {
    console.error(`[build-native-extractor] ${t.cc} failed for ${target}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`[build-native-extractor] Install the cross-compiler or set LYNX_NATIVE_EXTRACTOR_PATH at runtime to use a precompiled binary.`);
    return false;
  }
}

if (buildAll) {
  // Build for all known targets, naming each with the platform suffix
  let built = 0;
  for (const target of Object.keys(TARGETS)) {
    if (buildFor(target, `lynx_ts_extractor_${target}`)) built++;
  }
  console.log(`[build-native-extractor] Built ${built}/${Object.keys(TARGETS).length} platform variants.`);
} else {
  // Single target build
  const isCross = targetStr !== `${currentPlatform}-${currentArch}`;
  if (isCross) {
    console.log(`[build-native-extractor] Cross-compiling: ${currentPlatform}-${currentArch} -> ${targetStr}`);
    if (targetStr === 'linux-arm64' || targetStr === 'win-x64') {
      console.log('[build-native-extractor] Note: cross-compilers (aarch64-linux-gnu-gcc, x86_64-w64-mingw32-gcc) must be installed.');
    }
  }

  // Warn if host and target differ
  if (isCross && targetStr.startsWith('darwin') && currentPlatform === 'darwin') {
    // macOS cross-compilation: clang can do x64 <-> arm64 with -target flag
    console.log('[build-native-extractor] macOS cross-compilation supported via clang -target flag.');
  }

  buildFor(targetStr, 'lynx_ts_extractor');
}
