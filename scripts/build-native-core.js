#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-core-'));
const cc = process.env.CC || 'clang';
const cxx = process.env.CXX || 'clang++';
const include = path.join(root, 'node_modules/tree-sitter-runtime-source/vendor/tree-sitter/lib/include');
const runtimeSource = path.join(root, 'node_modules/tree-sitter-runtime-source/vendor/tree-sitter/lib/src');
const sqlite = path.join(root, 'node_modules/better-sqlite3/deps/sqlite3');
const output = path.join(root, 'native', 'lynx_native_core');
const sanitizerFlags = process.env.LYNX_NATIVE_SANITIZE === '1'
  ? ['-fsanitize=address,undefined', '-fno-omit-frame-pointer']
  : [];
const stagingModulePath = path.join(root, 'dist/native-core/staging.js');
if (!fs.existsSync(stagingModulePath)) {
  throw new Error('dist/native-core/staging.js is missing; run npm run build before build:native-core');
}
const { NATIVE_STAGING_DDL, NATIVE_STAGING_SCHEMA_VERSION } = await import(
  `${pathToFileURL(stagingModulePath).href}?mtime=${fs.statSync(stagingModulePath).mtimeMs}`
);
const schemaHeader = path.join(buildDir, 'native_staging_schema.h');
const ddlLiteral = Array.from(
  { length: Math.ceil(NATIVE_STAGING_DDL.length / 2_000) },
  (_, index) => JSON.stringify(NATIVE_STAGING_DDL.slice(index * 2_000, (index + 1) * 2_000)),
).join('\n');
fs.writeFileSync(schemaHeader,
  `#ifndef LYNX_NATIVE_STAGING_SCHEMA_H\n#define LYNX_NATIVE_STAGING_SCHEMA_H\n` +
  `#define LYNX_NATIVE_STAGING_SCHEMA_VERSION ${NATIVE_STAGING_SCHEMA_VERSION}\n` +
  `static const char LYNX_NATIVE_STAGING_DDL[] = ${ddlLiteral};\n` +
  `#endif\n`,
);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function object(name) {
  return path.join(buildDir, `${name}.o`);
}

const commonC = [
  '-O3',
  '-std=c11',
  '-D_POSIX_C_SOURCE=200809L',
  ...(process.platform === 'linux' ? ['-D_DEFAULT_SOURCE'] : []),
  ...sanitizerFlags,
];
// The generated staging DDL intentionally exceeds ISO C's conservative 4095-byte
// translation-limit guarantee; Clang supports it and every handwritten warning
// remains fatal in strict mode.
const coreWarnings = ['-Wall', '-Wextra', '-Wpedantic', '-Wno-overlength-strings',
  ...(process.env.LYNX_NATIVE_STRICT === '1' ? ['-Werror'] : [])];
run(cc, [...commonC, '-I', include, '-I', runtimeSource, '-c',
  path.join(runtimeSource, 'lib.c'), '-o', object('tree-sitter')]);
run(cc, [...commonC, '-I', include, '-c',
  path.join(root, 'node_modules/tree-sitter-c/src/parser.c'), '-o', object('c-parser')]);
run(cc, [...commonC, '-I', include, '-c',
  path.join(root, 'node_modules/tree-sitter-cpp/src/parser.c'), '-o', object('cpp-parser')]);
run(cc, [...commonC, '-I', include, '-c',
  path.join(root, 'node_modules/tree-sitter-cpp/src/scanner.c'), '-o', object('cpp-scanner')]);
run(cc, [...commonC, ...coreWarnings, '-I', include, '-I', sqlite, '-I', buildDir, '-c',
  path.join(root, 'native/core/lynx_native_core.c'), '-o', object('core')]);
run(cc, ['-O3', '-std=c11', '-DSQLITE_THREADSAFE=1', '-DSQLITE_OMIT_LOAD_EXTENSION', '-c',
  path.join(sqlite, 'sqlite3.c'), '-o', object('sqlite3')]);

run(cxx, [
  '-O3', '-pthread', ...sanitizerFlags,
  object('core'), object('tree-sitter'), object('c-parser'),
  object('cpp-parser'), object('cpp-scanner'), object('sqlite3'),
  ...(process.platform === 'linux' ? ['-ldl', '-lm'] : []),
  '-o', output,
]);
fs.chmodSync(output, 0o755);
fs.rmSync(buildDir, { recursive: true, force: true });
console.log(output);
