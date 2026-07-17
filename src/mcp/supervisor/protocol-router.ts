import { McpGenerationRouter } from './generation-router.js';

export type JsonRpcValue = Record<string, unknown>;

export interface RoutedMessage {
  generationId: string;
  message: JsonRpcValue;
}

function requestId(message: JsonRpcValue): string | number | null {
  return typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
}

export class McpProtocolRouter {
  constructor(private readonly generations: McpGenerationRouter) {}

  routeHostMessage(message: JsonRpcValue): RoutedMessage | null {
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw new Error('Invalid host JSON-RPC message.');
    if (message.method === 'notifications/cancelled') {
      const params = message.params as Record<string, unknown> | undefined;
      const id = params && (typeof params.requestId === 'string' || typeof params.requestId === 'number')
        ? params.requestId
        : null;
      if (id === null) throw new Error('Cancellation notification is missing requestId.');
      const route = this.generations.routeCancellation(id);
      if (!route) return null;
      return {
        generationId: route.generationId,
        message: { ...message, params: { ...params, requestId: route.internalId } },
      };
    }

    const id = requestId(message);
    if (id === null) return { generationId: this.generations.routeNotification(), message };
    const route = this.generations.routeRequest(id);
    return { generationId: route.generationId, message: { ...message, id: route.internalId } };
  }

  routeWorkerMessage(generationId: string, message: JsonRpcValue): JsonRpcValue | null {
    if (message.jsonrpc !== '2.0') throw new Error('Invalid worker JSON-RPC message.');
    const id = requestId(message);
    if (id !== null) {
      const completed = this.generations.completeResponse(generationId, String(id));
      return { ...message, id: completed.externalId };
    }
    const state = this.generations.stateOf(generationId);
    return state === 'active' || state === 'draining' ? message : null;
  }
}
