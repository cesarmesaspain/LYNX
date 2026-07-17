import { describe, expect, it } from 'vitest';
import { McpGenerationRouter } from '../../../src/mcp/supervisor/generation-router.js';

describe('MCP generation router', () => {
  it('promotes a verified generation while old requests drain on their owner', () => {
    const router = new McpGenerationRouter();
    router.startInitial('v1');
    const first = router.routeRequest(41);
    expect(first.generationId).toBe('v1');
    router.beginPreparation('v2');
    expect(router.promote('v2')).toBe('v1');
    const second = router.routeRequest(42);
    expect(second.generationId).toBe('v2');
    expect(router.routeCancellation(41)).toEqual(first);
    expect(router.completeResponse('v1', first.internalId)).toEqual({ externalId: 41, owner: 'v1', retired: true });
    expect(router.completeResponse('v2', second.internalId)).toEqual({ externalId: 42, owner: 'v2', retired: false });
    expect(router.snapshot()).toEqual([
      { id: 'v1', state: 'retired', inFlight: 0 },
      { id: 'v2', state: 'active', inFlight: 0 },
    ]);
  });

  it('keeps the active generation unchanged when preparation fails', () => {
    const router = new McpGenerationRouter();
    router.startInitial('v1');
    router.beginPreparation('broken');
    router.failPreparation('broken');
    expect(router.routeRequest('next').generationId).toBe('v1');
    expect(router.snapshot()).toEqual([
      { id: 'v1', state: 'active', inFlight: 1 },
      { id: 'broken', state: 'failed', inFlight: 0 },
    ]);
  });

  it('rejects request-id reuse until the owning response completes', () => {
    const router = new McpGenerationRouter();
    router.startInitial('v1');
    const first = router.routeRequest(7);
    expect(() => router.routeRequest(7)).toThrow('already in flight');
    router.completeResponse('v1', first.internalId);
    expect(router.routeRequest(7).generationId).toBe('v1');
  });

  it('retires an idle generation immediately and sends notifications to the new active worker', () => {
    const router = new McpGenerationRouter();
    router.startInitial('v1');
    router.beginPreparation('v2');
    router.promote('v2');
    expect(router.routeNotification()).toBe('v2');
    expect(router.routeCancellation(999)).toBeNull();
    expect(router.snapshot()[0]).toEqual({ id: 'v1', state: 'retired', inFlight: 0 });
  });

  it('assigns collision-free internal IDs and rejects responses from the wrong generation', () => {
    const router = new McpGenerationRouter();
    router.startInitial('v1');
    const first = router.routeRequest('lynx-supervisor/1');
    router.beginPreparation('v2');
    router.promote('v2');
    const second = router.routeRequest(1);
    expect(first.internalId).not.toBe(second.internalId);
    expect(() => router.completeResponse('v2', first.internalId)).toThrow('no routed request owner');
  });
});
