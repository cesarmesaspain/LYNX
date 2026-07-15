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

  it('requires LYNX first for broad code discovery while keeping later calls proportional', () => {
    for (const block of blocks) {
      expect(block).not.toContain('NO USES grep');
      expect(block).not.toContain('has violado esta regla');
      expect(block).toContain('REGLA BLOQUEANTE');
      expect(block).toContain('primera accion');
      expect(block).toContain('consulta mas pequena');
      expect(block).toContain('tool_search');
      expect(block).toContain('No puedes usar Bash, Read, Grep ni Glob');
      expect(block).toContain('cuando');
    }
  });

  it('makes the fresh-session discovery policy explicit in reminders and skills', () => {
    const source = fs.readFileSync('src/install/index.ts', 'utf8');
    expect(source).not.toContain('Before editing any function');
    expect(source).not.toContain('REGLA OBLIGATORIA');
    expect(source).toContain('use LYNX before shell/file tools');
    expect(source).toContain('Start broad work with pack_context(task)');
    expect(source).toContain('index_repository automatically');
    expect(source).toContain('consulta mas pequena');
    expect(source).toContain('Reuse evidence');
  });
});
