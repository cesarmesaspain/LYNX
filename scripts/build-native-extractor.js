#!/usr/bin/env node
/*
 * build-native-extractor.js — Compile the native C extractor for TS/TSX.
 *
 * Called before pkg bundling to ensure the binary exists and is
 * compiled for the target platform.
 *
 * In pkg, the binary is embedded as an asset and extracted to a temp
 * file at runtime. This script ensures it's compiled before packaging.
 */

import { execSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { platform, arch } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'native', 'lynx_ts_extractor.c');
const DST = join(ROOT, 'native', 'lynx_ts_extractor');

const currentPlatform = platform();
const currentArch = arch();

console.log(`[build-native-extractor] Platform: ${currentPlatform}-${currentArch}`);

if (!existsSync(SRC)) {
  console.log('[build-native-extractor] Native extractor source not found — skipping.');
  process.exit(0);
}

// Remove previous binary
try { unlinkSync(DST); } catch { /* didn't exist */ }

// macOS: clang
if (currentPlatform === 'darwin') {
  try {
    execSync(`clang -O3 "${SRC}" -o "${DST}"`, { stdio: 'inherit', cwd: ROOT });
    console.log(`[build-native-extractor] Compiled: ${DST}`);
  } catch (err) {
    console.error('[build-native-extractor] clang failed:', err.message);
    process.exit(1);
  }
} else if (currentPlatform === 'linux') {
  try {
    execSync(`gcc -O3 "${SRC}" -o "${DST}"`, { stdio: 'inherit', cwd: ROOT });
    console.log(`[build-native-extractor] Compiled: ${DST}`);
  } catch (err) {
    console.error('[build-native-extractor] gcc failed:', err.message);
    process.exit(1);
  }
} else {
  console.log(`[build-native-extractor] No compiler configured for ${currentPlatform} — skipping native extractor build.`);
}
