#!/usr/bin/env node
/*
 * fix-pkg-deps.js — Pre-build step for pkg binary packaging.
 *
 * pkg (@yao-pkg/pkg) doesn't fully support the "exports" field in package.json.
 * Some packages (web-tree-sitter) only use "exports" without a "main" field,
 * causing pkg to fail with "Cannot find module".
 *
 * This script adds a temporary "main" field to affected packages so pkg can
 * resolve them during the binary build. The changes are reverted after build
 * (or on next npm install).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PATCHES = [
  {
    name: 'web-tree-sitter',
    path: 'node_modules/web-tree-sitter/package.json',
    // Only has "exports", no "main" — pkg needs "main" for CJS resolution
    patch: (pkg) => {
      if (!pkg.main) { pkg.main = 'web-tree-sitter.cjs'; return true; }
      return false;
    },
  },
  {
    name: '@modelcontextprotocol/sdk',
    path: 'node_modules/@modelcontextprotocol/sdk/package.json',
    // Only has "exports", no "main"
    patch: (pkg) => {
      if (!pkg.main) { pkg.main = 'dist/cjs/index.js'; return true; }
      return false;
    },
  },
];

let patched = 0;
for (const { name, path, patch } of PATCHES) {
  try {
    const pkgPath = join(process.cwd(), path);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (patch(pkg)) {
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      console.log(`[fix-pkg-deps] Patched ${name}: added main field`);
      patched++;
    }
  } catch (err) {
    console.error(`[fix-pkg-deps] Warning: could not patch ${name}:`, err.message);
  }
}

if (patched > 0) {
  console.log(`[fix-pkg-deps] Patched ${patched} package(s) for pkg compatibility`);
}
