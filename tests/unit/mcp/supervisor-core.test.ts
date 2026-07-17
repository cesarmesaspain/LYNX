import { describe, expect, it, vi } from 'vitest';
import { McpSupervisorCore, type McpWorkerEndpoint } from '../../../src/mcp/supervisor/supervisor-core.js';

function endpoint(): McpWorkerEndpoint & { sent: any[] } {
  return { sent: [], send: async function (message) { this.sent.push(message); }, retire: vi.fn(), terminate: vi.fn() };
}

function probeResponses(worker: ReturnType<typeof endpoint>, tools: string[]) {
  const [initialize, identity, list] = worker.sent;
  return [
    { jsonrpc: '2.0', id: initialize.id, result: { serverInfo: { version: '0.2.0' } } },
    { jsonrpc: '2.0', id: identity.id, result: { schema: 'lynx.build-identity.v1', version: '0.2.0', distributionSha256: null } },
    { jsonrpc: '2.0', id: list.id, result: { tools: tools.map(name => ({ name })) } },
  ];
}

async function waitForProbe(worker: ReturnType<typeof endpoint>) {
  while (worker.sent.length < 3) await Promise.resolve();
}

describe('MCP supervisor core', () => {
  it('probes, promotes and drains the prior worker without losing host IDs', async () => {
    const host: any[] = [];
    const core = new McpSupervisorCore(message => host.push(message));
    const v1 = endpoint();
    const v2 = endpoint();
    core.startInitial('v1', v1);
    await core.routeHost({ jsonrpc: '2.0', id: 41, method: 'tools/call' });
    const oldInternalId = v1.sent[0].id;
    const prepared = core.prepare('v2', v2, { toolNames: ['a', 'b'] });
    await waitForProbe(v2);
    for (const response of probeResponses(v2, ['a', 'b'])) core.handleWorkerMessage('v2', response);
    await expect(prepared).resolves.toMatchObject({ toolCount: 2 });
    await core.routeHost({ jsonrpc: '2.0', id: 42, method: 'tools/list' });
    expect(v2.sent.at(-1).id).toMatch(/^lynx-supervisor\//);
    core.handleWorkerMessage('v1', { jsonrpc: '2.0', id: oldInternalId, result: { ok: true } });
    expect(host).toEqual([{ jsonrpc: '2.0', id: 41, result: { ok: true } }]);
    expect(v1.retire).not.toHaveBeenCalled();
    core.finalizePromotion();
    expect(v1.retire).toHaveBeenCalledOnce();
  });

  it('keeps the active worker and terminates a candidate that fails its catalog gate', async () => {
    const core = new McpSupervisorCore(vi.fn());
    const v1 = endpoint();
    const broken = endpoint();
    core.startInitial('v1', v1);
    const prepared = core.prepare('broken', broken, { toolNames: ['a', 'b'] });
    await waitForProbe(broken);
    for (const response of probeResponses(broken, ['a', 'wrong'])) core.handleWorkerMessage('broken', response);
    await expect(prepared).rejects.toThrow('catalog mismatch');
    expect(broken.terminate).toHaveBeenCalledOnce();
    await core.routeHost({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(v1.sent).toHaveLength(1);
  });

  it('restores a warm predecessor when the promoted active worker fails', async () => {
    const core = new McpSupervisorCore(vi.fn());
    const v1 = endpoint();
    const v2 = endpoint();
    core.startInitial('v1', v1);
    const prepared = core.prepare('v2', v2, { toolNames: ['a'] });
    await waitForProbe(v2);
    for (const response of probeResponses(v2, ['a'])) core.handleWorkerMessage('v2', response);
    await prepared;
    core.handleWorkerFailure('v2', new Error('post-promotion crash'));
    expect(v2.terminate).toHaveBeenCalledOnce();
    await core.routeHost({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
    expect(v1.sent).toHaveLength(1);
    expect(core.snapshot().find(item => item.id === 'v1')?.state).toBe('active');
  });
});
