/*
 * pass-semantic.test.ts — Unit tests for passSemanticLight.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LynxDatabase } from '../../../src/store/database.js';
import { passSemanticLight } from '../../../src/pipeline/phases/resolve/pass-semantic.js';
import type { LynxEdge } from '../../../src/types.js';
import type { ExtractionResult } from '../../../src/extraction/extractor.js';
import {
  resetIdCounter, makeFileNode,
  makeEmptyResult, makeBatch, createEmptyIndexes, populateIndex, getEdgesByType,
} from './helpers.js';

function makeEnvUsageResult(envName: string): ExtractionResult {
  return {
    ...makeEmptyResult(),
    usages: [{ refName: envName, enclosingFuncQn: 'app.main', startLine: 3 }],
  };
}

function makeChannelResult(name: string, transport: string = 'redis'): ExtractionResult {
  return {
    ...makeEmptyResult(),
    channels: [{ channelName: name, transport, enclosingFuncQn: 'app.main', direction: 'emit', startLine: 8 }],
  };
}

describe('passSemanticLight', () => {
  let db: LynxDatabase;

  beforeEach(() => {
    db = LynxDatabase.openMemory();
    resetIdCounter();
  });

  it('creates CONFIGURES edge for process.env or NEXT_PUBLIC_ usage', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode]);

    const batch = makeBatch('src/app.ts', '/fake/src/app.ts',
      makeEnvUsageResult('NEXT_PUBLIC_API_URL'));
    const edges: LynxEdge[] = [];
    passSemanticLight(db, [batch], idx, edges);

    const configEdges = getEdgesByType(edges, 'CONFIGURES');
    expect(configEdges.length).toBe(1);
    expect(configEdges[0].sourceId).toBe(1);
    expect(configEdges[0].properties.refName).toBe('NEXT_PUBLIC_API_URL');
    expect(configEdges[0].properties.resolution).toBe('env-usage');
  });

  it('creates CONFIGURES edge for process env var', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode]);

    const result = makeEmptyResult();
    result.usages = [{ refName: 'process', enclosingFuncQn: 'app.main', startLine: 1 }];
    const batch = makeBatch('src/app.ts', '/fake/src/app.ts', result);
    const edges: LynxEdge[] = [];
    passSemanticLight(db, [batch], idx, edges);

    const configEdges = getEdgesByType(edges, 'CONFIGURES');
    expect(configEdges.length).toBe(1);
  });

  it('creates EMITS edge for channel with emit direction', () => {
    const fileNode = makeFileNode(1, 'src/app.ts');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode]);

    const batch = makeBatch('src/app.ts', '/fake/src/app.ts',
      makeChannelResult('user.created', 'rabbitmq'));
    const edges: LynxEdge[] = [];
    passSemanticLight(db, [batch], idx, edges);

    const emitEdges = getEdgesByType(edges, 'EMITS');
    expect(emitEdges.length).toBe(1);
    expect(emitEdges[0].sourceId).toBe(1);
    expect(emitEdges[0].properties.channelName).toBe('user.created');
    expect(emitEdges[0].properties.transport).toBe('rabbitmq');
    expect(emitEdges[0].properties.direction).toBe('emit');
    const channel = db.db.prepare("SELECT is_entry_point FROM nodes WHERE kind = 'Channel'")
      .get() as { is_entry_point: number };
    expect(channel.is_entry_point).toBe(0);

    // Existing synthetic rows must also be repaired on subsequent resolver passes.
    db.db.prepare("UPDATE nodes SET is_entry_point = 1 WHERE kind = 'Channel'").run();
    passSemanticLight(db, [batch], idx, []);
    const repaired = db.db.prepare("SELECT is_entry_point FROM nodes WHERE kind = 'Channel'")
      .get() as { is_entry_point: number };
    expect(repaired.is_entry_point).toBe(0);
  });

  it('creates LISTENS_ON edge for channel with listen direction', () => {
    const fileNode = makeFileNode(1, 'src/consumer.ts');
    const idx = createEmptyIndexes();
    populateIndex(db, idx, [fileNode]);

    const result: ExtractionResult = {
      ...makeEmptyResult(),
      channels: [{ channelName: 'events', transport: 'kafka', enclosingFuncQn: 'consumer.start', direction: 'listen', startLine: 5 }],
    };
    const batch = makeBatch('src/consumer.ts', '/fake/src/consumer.ts', result);
    const edges: LynxEdge[] = [];
    passSemanticLight(db, [batch], idx, edges);

    const listenEdges = getEdgesByType(edges, 'LISTENS_ON');
    expect(listenEdges.length).toBe(1);
    expect(listenEdges[0].properties.direction).toBe('listen');
  });

  it('skip when file node not found', () => {
    const idx = createEmptyIndexes();
    const batch = makeBatch('src/ghost.ts', '/fake/src/ghost.ts', makeEnvUsageResult('FOO'));
    const edges: LynxEdge[] = [];
    expect(() => passSemanticLight(db, [batch], idx, edges)).not.toThrow();
    expect(edges.length).toBe(0);
  });
});
