import { describe, expect, it } from 'vitest';
import { McpGenerationRouter } from '../../../src/mcp/supervisor/generation-router.js';
import { McpProtocolRouter } from '../../../src/mcp/supervisor/protocol-router.js';

describe('MCP supervisor protocol translation', () => {
  it('round-trips host IDs without exposing them to a worker', () => {
    const generations = new McpGenerationRouter();
    generations.startInitial('v1');
    const protocol = new McpProtocolRouter(generations);
    const routed = protocol.routeHostMessage({ jsonrpc: '2.0', id: 41, method: 'tools/list' })!;
    expect(routed.generationId).toBe('v1');
    expect(routed.message.id).toMatch(/^lynx-supervisor\//);
    expect(routed.message.id).not.toBe(41);
    expect(protocol.routeWorkerMessage('v1', { jsonrpc: '2.0', id: routed.message.id, result: {} }))
      .toEqual({ jsonrpc: '2.0', id: 41, result: {} });
  });

  it('routes cancellation to the old draining generation with its internal ID', () => {
    const generations = new McpGenerationRouter();
    generations.startInitial('v1');
    const protocol = new McpProtocolRouter(generations);
    const request = protocol.routeHostMessage({ jsonrpc: '2.0', id: 'task', method: 'tools/call' })!;
    generations.beginPreparation('v2');
    generations.promote('v2');
    const cancellation = protocol.routeHostMessage({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'task', reason: 'user' },
    })!;
    expect(cancellation.generationId).toBe('v1');
    expect((cancellation.message.params as Record<string, unknown>).requestId).toBe(request.message.id);
  });

  it('drops unknown cancellations and notifications from non-active probe workers', () => {
    const generations = new McpGenerationRouter();
    generations.startInitial('v1');
    generations.beginPreparation('probe');
    const protocol = new McpProtocolRouter(generations);
    expect(protocol.routeHostMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 } })).toBeNull();
    expect(protocol.routeWorkerMessage('probe', { jsonrpc: '2.0', method: 'notifications/message', params: {} })).toBeNull();
  });
});
