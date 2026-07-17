export type GenerationState = 'preparing' | 'active' | 'draining' | 'retired' | 'failed';

export interface GenerationSnapshot {
  id: string;
  state: GenerationState;
  inFlight: number;
}

export interface RoutedRequest {
  generationId: string;
  internalId: string;
}

interface RequestOwner extends RoutedRequest {
  externalId: string | number;
}

export class McpGenerationRouter {
  private readonly states = new Map<string, GenerationState>();
  private readonly requestOwners = new Map<string | number, RequestOwner>();
  private readonly internalOwners = new Map<string, RequestOwner>();
  private activeId: string | null = null;
  private nextInternalId = 1;

  startInitial(generationId: string): void {
    if (this.states.size > 0) throw new Error('Initial MCP generation is already established.');
    this.states.set(generationId, 'active');
    this.activeId = generationId;
  }

  beginPreparation(generationId: string): void {
    if (!this.activeId) throw new Error('Cannot prepare an MCP generation before initial startup.');
    if (this.states.has(generationId)) throw new Error(`MCP generation already exists: ${generationId}.`);
    this.states.set(generationId, 'preparing');
  }

  failPreparation(generationId: string): void {
    if (this.states.get(generationId) !== 'preparing') throw new Error(`MCP generation is not preparing: ${generationId}.`);
    this.states.set(generationId, 'failed');
  }

  promote(generationId: string): string {
    if (this.states.get(generationId) !== 'preparing') throw new Error(`MCP generation is not ready for promotion: ${generationId}.`);
    const previous = this.requireActive();
    this.states.set(previous, this.inFlightFor(previous) === 0 ? 'retired' : 'draining');
    this.states.set(generationId, 'active');
    this.activeId = generationId;
    return previous;
  }

  routeRequest(requestId: string | number): RoutedRequest {
    if (this.requestOwners.has(requestId)) throw new Error(`JSON-RPC request id is already in flight: ${String(requestId)}.`);
    const generationId = this.requireActive();
    const internalId = `lynx-supervisor/${this.nextInternalId++}`;
    const owner = { externalId: requestId, generationId, internalId };
    this.requestOwners.set(requestId, owner);
    this.internalOwners.set(this.internalKey(generationId, internalId), owner);
    return { generationId, internalId };
  }

  routeNotification(): string {
    return this.requireActive();
  }

  routeCancellation(requestId: string | number): RoutedRequest | null {
    const owner = this.requestOwners.get(requestId);
    return owner ? { generationId: owner.generationId, internalId: owner.internalId } : null;
  }

  completeResponse(generationId: string, internalId: string): { externalId: string | number; owner: string; retired: boolean } {
    const key = this.internalKey(generationId, internalId);
    const request = this.internalOwners.get(key);
    if (!request) throw new Error(`JSON-RPC response has no routed request owner: ${generationId}/${internalId}.`);
    this.internalOwners.delete(key);
    this.requestOwners.delete(request.externalId);
    let retired = false;
    if (this.states.get(generationId) === 'draining' && this.inFlightFor(generationId) === 0) {
      this.states.set(generationId, 'retired');
      retired = true;
    }
    return { externalId: request.externalId, owner: generationId, retired };
  }

  snapshot(): GenerationSnapshot[] {
    return [...this.states].map(([id, state]) => ({ id, state, inFlight: this.inFlightFor(id) }));
  }

  private requireActive(): string {
    if (!this.activeId || this.states.get(this.activeId) !== 'active') throw new Error('No active MCP generation.');
    return this.activeId;
  }

  private inFlightFor(generationId: string): number {
    let count = 0;
    for (const owner of this.requestOwners.values()) if (owner.generationId === generationId) count++;
    return count;
  }

  private internalKey(generationId: string, internalId: string): string {
    return `${generationId}\0${internalId}`;
  }
}
