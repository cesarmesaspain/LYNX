import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import {
  initInstructionsBlock,
  installInstructionsBlock,
} from '../../../src/install/instructions.js';

describe('managed LYNX instruction blocks', () => {
  const blocks = [
    installInstructionsBlock(),
    initInstructionsBlock({
      projectName: 'demo',
      nodes: 10,
      edges: 20,
      languages: ['TypeScript'],
      topHotspots: ['main'],
      fileCount: 3,
    }),
  ];

  it('recommends proportional tool selection instead of absolute sequencing', () => {
    for (const block of blocks) {
      expect(block).not.toContain('SIEMPRE primero');
      expect(block).not.toContain('NO USES grep');
      expect(block).not.toContain('has violado esta regla');
      expect(block).toContain('consulta mas pequena');
      expect(block).toContain('cuando');
    }
  });

  it('keeps installation reminders and generated skills proportional', () => {
    const source = fs.readFileSync('src/install/index.ts', 'utf8');
    expect(source).not.toContain('always first for non-trivial tasks');
    expect(source).not.toContain('Before editing any function');
    expect(source).not.toContain('REGLA OBLIGATORIA');
    expect(source).not.toContain('SIEMPRE primero');
    expect(source).toContain('smallest relevant tool set');
    expect(source).toContain('consulta mas pequena');
    expect(source).toContain('stop when it is sufficient');
  });
});
