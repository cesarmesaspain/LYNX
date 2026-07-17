import { describe, expect, it } from 'vitest';
import { McpWorkerProbe } from '../../../src/mcp/supervisor/worker-probe.js';

function responses(probe: McpWorkerProbe, tools = ['a', 'b'], hash: string | null = 'a'.repeat(64)) {
  const [initialize, identity, list] = probe.requests();
  return [
    { jsonrpc: '2.0', id: list.id, result: { tools: tools.map(name => ({ name })) } },
    { jsonrpc: '2.0', id: initialize.id, result: { serverInfo: { name: 'lynx', version: '0.2.0' } } },
    { jsonrpc: '2.0', id: identity.id, result: {
      schema: 'lynx.build-identity.v1', version: '0.2.0', sourceCommit: null,
      distributionSha256: hash, nativeCoreSha256: null, builtAt: null, runtime: 'packaged',
    } },
  ];
}

describe('MCP worker candidate probe', () => {
  it('accepts out-of-order responses only after identity and exact tools agree', () => {
    const probe = new McpWorkerProbe({ toolNames: ['a', 'b'], distributionSha256: 'a'.repeat(64) });
    const [tools, initialize, identity] = responses(probe);
    expect(probe.accept(tools)).toBeNull();
    expect(probe.accept(initialize)).toBeNull();
    expect(probe.accept(identity)).toMatchObject({ toolCount: 2, identity: { version: '0.2.0' } });
  });

  it('rejects mixed build identity and catalog divergence', () => {
    const mixed = new McpWorkerProbe({ toolNames: ['a', 'b'], distributionSha256: 'a'.repeat(64) });
    const mixedResponses = responses(mixed, ['a', 'b'], 'b'.repeat(64));
    mixed.accept(mixedResponses[0]);
    mixed.accept(mixedResponses[1]);
    expect(() => mixed.accept(mixedResponses[2])).toThrow('does not match');

    const catalog = new McpWorkerProbe({ toolNames: ['a', 'b'] });
    const catalogResponses = responses(catalog, ['a', 'c']);
    catalog.accept(catalogResponses[0]);
    catalog.accept(catalogResponses[1]);
    expect(() => catalog.accept(catalogResponses[2])).toThrow('catalog mismatch');
  });

  it('ignores messages outside its private probe namespace', () => {
    const probe = new McpWorkerProbe({ toolNames: [] });
    expect(probe.accept({ jsonrpc: '2.0', id: 41, result: {} })).toBeUndefined();
  });
});
