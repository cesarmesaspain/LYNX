import { describe, expect, it } from 'vitest';
import { verifyMcpServer } from '../../../src/install/mcp-verify.js';
import { TOOLS } from '../../../src/mcp/tools.js';

function fixture(toolNames: string[]): string {
  return [
    'const names = JSON.parse(process.argv[1]);',
    'let input = "";',
    'process.stdin.on("data", chunk => input += chunk);',
    'process.stdin.on("end", () => {',
    '  for (const line of input.trim().split("\\n")) {',
    '    const request = JSON.parse(line);',
    '    if (request.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));',
    '    if (request.id === 2) console.log(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: names.map(name => ({ name })) } }));',
    '  }',
    '});',
  ].join('\n');
}

describe('verifyMcpServer', () => {
  it('accepts a complete initialize plus tools/list handshake', async () => {
    const names = TOOLS.map(tool => tool.name);
    const result = await verifyMcpServer(process.execPath, ['-e', fixture(names), JSON.stringify(names)]);
    expect(result).toMatchObject({ ok: true, expected: names.length, discovered: names.length, missing: [] });
  });

  it('reports missing tools from an otherwise valid handshake', async () => {
    const names = TOOLS.slice(1).map(tool => tool.name);
    const result = await verifyMcpServer(process.execPath, ['-e', fixture(names), JSON.stringify(names)]);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain(TOOLS[0].name);
  });
});
