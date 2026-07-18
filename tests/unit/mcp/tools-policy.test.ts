import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { TOOLS } from '../../../src/mcp/tools.js';

describe('MCP tool guidance policy', () => {
  it('keeps tool descriptions conditional and proportional', () => {
    const descriptions = TOOLS.map((tool) => tool.description).join('\n');
    expect(descriptions).not.toContain('before editing code');
    expect(descriptions).not.toContain('INSTEAD OF grep/glob');
    expect(descriptions).toContain('Use for quality, scalability, or risk, not as a first overview');
  });

  it('keeps strict hook messaging focused without universal replacements', () => {
    const source = fs.readFileSync('src/cli/hook-augment.ts', 'utf8');
    expect(source).not.toContain('search_graph en vez de grep/find');
    expect(source).not.toContain('NO uses grep/Read/Glob para codigo');
    expect(source).not.toContain('En vez de Read, usa:');
    expect(source).not.toContain('en vez de Read para archivos');
    expect(source).toContain('tool MCP de LYNX mas pequena');
    expect(source).toContain('cuando callers, callees o flujo sean relevantes');
  });
});
