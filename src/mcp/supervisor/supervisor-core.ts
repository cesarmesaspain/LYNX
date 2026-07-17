import type { JsonRpcValue } from './protocol-router.js';
import { McpProtocolRouter } from './protocol-router.js';
import { McpGenerationRouter } from './generation-router.js';
import { McpWorkerProbe, type WorkerProbeExpectation, type WorkerProbeResult } from './worker-probe.js';

export interface McpWorkerEndpoint {
  send(message: JsonRpcValue): Promise<void>;
  retire(): void;
  terminate(): void;
}

interface PendingProbe {
  probe: McpWorkerProbe;
  resolve: (result: WorkerProbeResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpSupervisorCore {
  private readonly generations = new McpGenerationRouter();
  private readonly protocol = new McpProtocolRouter(this.generations);
  private readonly workers = new Map<string, McpWorkerEndpoint>();
  private readonly probes = new Map<string, PendingProbe>();

  constructor(private readonly emitHost: (message: JsonRpcValue) => void) {}

  startInitial(generationId: string, endpoint: McpWorkerEndpoint): void {
    this.generations.startInitial(generationId);
    this.workers.set(generationId, endpoint);
  }

  async routeHost(message: JsonRpcValue): Promise<void> {
    const route = this.protocol.routeHostMessage(message);
    if (!route) return;
    const worker = this.workers.get(route.generationId);
    if (!worker) throw new Error(`MCP worker endpoint is unavailable: ${route.generationId}.`);
    await worker.send(route.message);
  }

  async prepare(
    generationId: string,
    endpoint: McpWorkerEndpoint,
    expected: WorkerProbeExpectation,
    timeoutMs = 8_000,
  ): Promise<WorkerProbeResult> {
    this.generations.beginPreparation(generationId);
    this.workers.set(generationId, endpoint);
    const probe = new McpWorkerProbe(expected);
    const completion = new Promise<WorkerProbeResult>((resolve, reject) => {
      const timer = setTimeout(() => this.failProbe(generationId, new Error(`MCP worker probe timed out after ${timeoutMs}ms.`)), timeoutMs);
      this.probes.set(generationId, { probe, resolve, reject, timer });
    });
    try {
      for (const request of probe.requests()) await endpoint.send(request);
    } catch (error) {
      this.failProbe(generationId, error instanceof Error ? error : new Error(String(error)));
    }
    return completion;
  }

  handleWorkerMessage(generationId: string, message: JsonRpcValue): void {
    const pending = this.probes.get(generationId);
    if (pending) {
      try {
        const result = pending.probe.accept(message);
        if (result !== undefined) {
          if (result) {
            clearTimeout(pending.timer);
            this.probes.delete(generationId);
            this.generations.promote(generationId);
            this.retireCompletedWorkers();
            pending.resolve(result);
          }
          return;
        }
      } catch (error) {
        this.failProbe(generationId, error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
    const hostMessage = this.protocol.routeWorkerMessage(generationId, message);
    if (hostMessage) this.emitHost(hostMessage);
    this.retireCompletedWorkers();
  }

  handleWorkerFailure(generationId: string, error: Error): void {
    if (this.probes.has(generationId)) this.failProbe(generationId, error);
  }

  snapshot() {
    return this.generations.snapshot();
  }

  private failProbe(generationId: string, error: Error): void {
    const pending = this.probes.get(generationId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.probes.delete(generationId);
    this.generations.failPreparation(generationId);
    this.workers.get(generationId)?.terminate();
    this.workers.delete(generationId);
    pending.reject(error);
  }

  private retireCompletedWorkers(): void {
    for (const generation of this.generations.snapshot()) {
      if (generation.state !== 'retired') continue;
      const worker = this.workers.get(generation.id);
      if (!worker) continue;
      worker.retire();
      this.workers.delete(generation.id);
    }
  }
}
