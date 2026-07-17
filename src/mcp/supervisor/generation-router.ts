export type GenerationState = 'preparing' | 'active' | 'draining' | 'retired' | 'failed';

export interface GenerationSnapshot {
  id: string;
  state: GenerationState;
  inFlight: number;
}

export class McpGenerationRouter {
  private readonly states = new Map<string, GenerationState>();
  private readonly requestOwners = new Map<string | number, string>();
  private activeId: string | null = null;

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

  routeRequest(requestId: string | number): string {
    if (this.requestOwners.has(requestId)) throw new Error(`JSON-RPC request id is already in flight: ${String(requestId)}.`);
    const owner = this.requireActive();
    this.requestOwners.set(requestId, owner);
    return owner;
  }

  routeNotification(): string {
    return this.requireActive();
  }

  routeCancellation(requestId: string | number): string | null {
    return this.requestOwners.get(requestId) ?? null;
  }

  completeRequest(requestId: string | number): { owner: string; retired: boolean } {
    const owner = this.requestOwners.get(requestId);
    if (!owner) throw new Error(`JSON-RPC request id is not in flight: ${String(requestId)}.`);
    this.requestOwners.delete(requestId);
    let retired = false;
    if (this.states.get(owner) === 'draining' && this.inFlightFor(owner) === 0) {
      this.states.set(owner, 'retired');
      retired = true;
    }
    return { owner, retired };
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
    for (const owner of this.requestOwners.values()) if (owner === generationId) count++;
    return count;
  }
}
