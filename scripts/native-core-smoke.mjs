#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { validateNativeStaging } from '../dist/native-core/staging.js';

const root = path.resolve(import.meta.dirname, '..');
const fixture = path.join(root, 'tests/fixtures/native-core');
const staging = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-smoke-')), 'staging.db');
const binary = path.join(root, 'native/lynx_native_core');
const run = spawnSync(binary, [
  'native-fixture', fixture, path.join(fixture, 'manifest.tsv'), staging, '3', 'full',
], { cwd: root, encoding: 'utf8' });
if (run.status !== 0) throw new Error(run.stderr || `native core exited ${run.status}`);

const db = new Database(staging, { readonly: true });
try {
  const validation = validateNativeStaging(db, 'native-fixture');
  if (!validation.valid) throw new Error(validation.errors.join('; '));
  const identities = db.prepare(
    "SELECT qualified_name FROM native_nodes WHERE name = 'add_numbers' ORDER BY qualified_name",
  ).all().map((row) => row.qualified_name);
  const mainCall = db.prepare(
    "SELECT COUNT(*) AS count FROM native_calls WHERE enclosing_qualified_name = 'math.main' AND callee_name = 'add_numbers'",
  ).get().count;
  const mathSource = fs.readFileSync(path.join(fixture, 'src/math.c'));
  const expectedHash = createHash('sha256').update(mathSource).digest('hex');
  const nativeHash = db.prepare(
    "SELECT sha256 FROM native_files WHERE rel_path = 'src/math.c'",
  ).get().sha256;
  const totalUsages = db.prepare(`
    SELECT is_write FROM native_usages
    WHERE enclosing_qualified_name = 'math.main' AND referenced_name = 'running_total'
    ORDER BY is_write
  `).all().map((row) => row.is_write);
  const typeMembers = db.prepare(`
    SELECT kind, name FROM native_nodes
    WHERE qualified_name LIKE 'include.math.__header.__tag.Counter.%'
       OR qualified_name LIKE 'include.math.__header.__tag.State.%'
    ORDER BY kind, name
  `).all();
  const typeKinds = db.prepare(`
    SELECT kind, name FROM native_nodes
    WHERE name IN ('Counter', 'State', 'Payload')
    ORDER BY kind, name
  `).all();
  const moduleValues = db.prepare(`
    SELECT kind, name, is_exported FROM native_nodes
    WHERE name IN ('running_total', 'public_value', 'second_value', 'current_value', 'transform_value')
    ORDER BY name
  `).all();
  const cppSymbols = db.prepare(`
    SELECT kind, name, qualified_name FROM native_nodes
    WHERE file_id = (SELECT id FROM native_files WHERE rel_path = 'src/widget.cpp')
    ORDER BY qualified_name
  `).all();
  const methodCalls = db.prepare(`
    SELECT callee_name FROM native_calls
    WHERE enclosing_qualified_name = 'widget.ui.Widget.size'
    ORDER BY callee_name
  `).all().map((row) => row.callee_name);
  const macros = db.prepare(`
    SELECT name FROM native_nodes WHERE kind = 'Macro' ORDER BY name
  `).all().map((row) => row.name);
  const resolvedEdges = db.prepare(`
    SELECT source_qualified_name AS source,target_qualified_name AS target,type,strategy
    FROM native_edges ORDER BY source,type,target
  `).all();
  const resolvedInclude = db.prepare(`
    SELECT resolved_rel_path FROM native_imports
    WHERE file_id=(SELECT id FROM native_files WHERE rel_path='src/consumer.c')
  `).get()?.resolved_rel_path;
  if (identities.length !== 2 || !identities.some((value) => value.includes('__header')) ||
      mainCall !== 1 || nativeHash !== expectedHash || totalUsages.join(',') !== '0,1' ||
      !typeMembers.some((row) => row.kind === 'Field' && row.name === 'history') ||
      !typeMembers.some((row) => row.kind === 'EnumMember' && row.name === 'STATE_BUSY') ||
      !typeKinds.some((row) => row.kind === 'Struct' && row.name === 'Counter') ||
      !typeKinds.some((row) => row.kind === 'TypeAlias' && row.name === 'Counter') ||
      !typeKinds.some((row) => row.kind === 'Union' && row.name === 'Payload') ||
      !moduleValues.some((row) => row.name === 'second_value' && row.kind === 'Variable') ||
      !moduleValues.some((row) => row.name === 'current_value' && row.kind === 'Variable') ||
      !moduleValues.some((row) => row.name === 'transform_value' && row.kind === 'FunctionPointer') ||
      !cppSymbols.some((row) => row.kind === 'Namespace' && row.qualified_name === 'widget.ui') ||
      !cppSymbols.some((row) => row.kind === 'Class' && row.qualified_name === 'widget.ui.Widget') ||
      !cppSymbols.some((row) => row.kind === 'Constructor' && row.qualified_name === 'widget.ui.Widget.Widget') ||
      !cppSymbols.some((row) => row.kind === 'Destructor' && row.qualified_name === 'widget.ui.Widget.~Widget') ||
      !cppSymbols.some((row) => row.kind === 'Method' && row.qualified_name === 'widget.ui.Widget.size') ||
      !methodCalls.includes('label') || !methodCalls.includes('size') || !methodCalls.includes('static_cast') ||
      !macros.includes('MATH_LIMIT') || !macros.includes('MATH_DOUBLE') ||
      resolvedInclude !== 'include/math.h' ||
      !resolvedEdges.some((edge) => edge.source === 'math.main' && edge.target === 'math.add_numbers' && edge.strategy === 'same_file_direct_unique') ||
      !resolvedEdges.some((edge) => edge.source === 'consumer.consume_numbers' && edge.target === 'math.add_numbers' && edge.strategy === 'include_declaration_unique_implementation') ||
      !resolvedEdges.some((edge) => edge.source === 'consumer.consume_numbers' && edge.target === 'math.hidden_helper' && edge.strategy === 'global_unique_name_same_language') ||
      !resolvedEdges.some((edge) => edge.source === 'consumer.consume_numbers' && edge.target === 'math.add_numbers' && edge.strategy === 'macro_expansion_call') ||
      !resolvedEdges.some((edge) => edge.source === 'local_consumer.consume_local' && edge.target === 'local_api.local_pick' && edge.strategy === 'import_reachable_candidate') ||
      resolvedEdges.some((edge) => edge.source === 'local_consumer.consume_local' && edge.target === 'other.local_api.local_pick') ||
      !resolvedEdges.some((edge) => edge.source === 'widget.ui.Widget.size' && edge.target === 'widget.ui.label') ||
      !resolvedEdges.some((edge) => edge.source === 'widget.ui.measure_widget' && edge.target === 'widget.ui.Widget.size' && edge.strategy === 'receiver_declared_type_member') ||
      resolvedEdges.some((edge) => edge.source === 'widget.ui.measure_widget' && edge.target === 'widget.ui.Gadget.size') ||
      resolvedEdges.some((edge) => edge.source === 'widget.ui.measure_generic' && edge.target.endsWith('.size')) ||
      resolvedEdges.some((edge) => edge.source === 'widget.ui.Widget.size' && edge.target === 'widget.ui.Widget.size')) {
    throw new Error(`native precision oracle failed: ${JSON.stringify({ identities, mainCall, nativeHash, expectedHash, totalUsages, typeMembers, typeKinds, moduleValues, cppSymbols, methodCalls, macros, resolvedInclude, resolvedEdges })}`);
  }
  console.log(JSON.stringify({ validation, identities, mainCall, nativeHash, totalUsages, typeMembers, typeKinds, moduleValues, cppSymbols, methodCalls, macros, resolvedInclude, resolvedEdges }));
} finally {
  db.close();
}
