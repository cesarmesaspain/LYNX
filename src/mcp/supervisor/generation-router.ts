export type GenerationState = 'preparing' | 'active' | 'draining' | 'standby' | 'retired' | 'failed';

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

  beginInitialPreparation(generationId: string): void {
    if (this.states.size > 0 || this.activeId) throw new Error('Initial MCP generation is already established.');
    this.states.set(generationId, 'preparing');
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
    if (!this.activeId) {
      this.states.set(generationId, 'active');
      this.activeId = generationId;
      return generationId;
    }
    const previous = this.requireActive();
    this.states.set(previous, this.inFlightFor(previous) === 0 ? 'standby' : 'draining');
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

  completeResponse(generationId: string, internalId: string): { externalId: string | number; owner: string; standby: boolean } {
    const key = this.internalKey(generationId, internalId);
    const request = this.internalOwners.get(key);
    if (!request) throw new Error(`JSON-RPC response has no routed request owner: ${generationId}/${internalId}.`);
    this.internalOwners.delete(key);
    this.requestOwners.delete(request.externalId);
    let standby = false;
    if (this.states.get(generationId) === 'draining' && this.inFlightFor(generationId) === 0) {
      this.states.set(generationId, 'standby');
      standby = true;
    }
    return { externalId: request.externalId, owner: generationId, standby };
  }

  rollbackActive(failedGenerationId: string): string {
    if (this.activeId !== failedGenerationId || this.states.get(failedGenerationId) !== 'active') {
      throw new Error(`MCP generation is not active: ${failedGenerationId}.`);
    }
    const candidates = [...this.states].filter(([, state]) => state === 'standby' || state === 'draining');
    if (candidates.length !== 1) throw new Error('No unique MCP predecessor is available for generation rollback.');
    const previous = candidates[0][0];
    this.states.set(failedGenerationId, 'failed');
    this.states.set(previous, 'active');
    this.activeId = previous;
    return previous;
  }

  failActiveWithoutRollback(failedGenerationId: string): void {
    if (this.activeId !== failedGenerationId || this.states.get(failedGenerationId) !== 'active') {
      throw new Error(`MCP generation is not active: ${failedGenerationId}.`);
    }
    this.states.set(failedGenerationId, 'failed');
    this.activeId = null;
  }

  finalizeStandby(): string[] {
    const retired: string[] = [];
    for (const [id, state] of this.states) {
      if (state !== 'standby') continue;
      this.states.set(id, 'retired');
      retired.push(id);
    }
    return retired;
  }

  snapshot(): GenerationSnapshot[] {
    return [...this.states].map(([id, state]) => ({ id, state, inFlight: this.inFlightFor(id) }));
  }

  stateOf(generationId: string): GenerationState | null {
    return this.states.get(generationId) ?? null;
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
