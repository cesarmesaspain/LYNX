import type { LynxBuildIdentity } from '../../build-identity.js';
import type { JsonRpcValue } from './protocol-router.js';

export interface WorkerProbeExpectation {
  toolNames: string[];
  distributionSha256?: string;
}

export interface WorkerProbeResult {
  identity: LynxBuildIdentity;
  toolCount: number;
}

export class McpWorkerProbe {
  private readonly prefix = `lynx-probe/${process.pid}/${Date.now()}/${Math.random().toString(16).slice(2)}`;
  private initializeVersion: string | null = null;
  private identity: LynxBuildIdentity | null = null;
  private tools: string[] | null = null;

  constructor(private readonly expected: WorkerProbeExpectation) {}

  requests(): JsonRpcValue[] {
    return [
      { jsonrpc: '2.0', id: `${this.prefix}/initialize`, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: `${this.prefix}/identity`, method: 'lynx/buildIdentity', params: {} },
      { jsonrpc: '2.0', id: `${this.prefix}/tools`, method: 'tools/list', params: {} },
    ];
  }

  accept(message: JsonRpcValue): WorkerProbeResult | null {
    if (typeof message.id !== 'string' || !message.id.startsWith(`${this.prefix}/`)) return null;
    if (message.error) throw new Error(`MCP worker probe failed: ${JSON.stringify(message.error)}.`);
    const result = message.result as Record<string, unknown> | undefined;
    if (!result) throw new Error('MCP worker probe response has no result.');
    if (message.id.endsWith('/initialize')) {
      const info = result.serverInfo as Record<string, unknown> | undefined;
      if (!info || typeof info.version !== 'string') throw new Error('MCP worker initialize response has no version.');
      this.initializeVersion = info.version;
    } else if (message.id.endsWith('/identity')) {
      if (result.schema !== 'lynx.build-identity.v1' || typeof result.version !== 'string') {
        throw new Error('MCP worker returned an invalid build identity.');
      }
      this.identity = result as unknown as LynxBuildIdentity;
    } else if (message.id.endsWith('/tools')) {
      if (!Array.isArray(result.tools)) throw new Error('MCP worker tools response is invalid.');
      this.tools = result.tools.map(tool => (tool as Record<string, unknown>).name).filter((name): name is string => typeof name === 'string');
    }
    return this.finishIfComplete();
  }

  private finishIfComplete(): WorkerProbeResult | null {
    if (!this.initializeVersion || !this.identity || !this.tools) return null;
    if (this.initializeVersion !== this.identity.version) throw new Error('MCP worker initialize/build identity versions disagree.');
    if (this.expected.distributionSha256 && this.identity.distributionSha256 !== this.expected.distributionSha256) {
      throw new Error('MCP worker distribution identity does not match the accepted artifact.');
    }
    const expected = [...new Set(this.expected.toolNames)].sort();
    const observed = [...new Set(this.tools)].sort();
    if (expected.length !== observed.length || expected.some((name, index) => name !== observed[index])) {
      const missing = expected.filter(name => !observed.includes(name));
      const unexpected = observed.filter(name => !expected.includes(name));
      throw new Error(`MCP worker tool catalog mismatch; missing=${missing.join(',') || 'none'} unexpected=${unexpected.join(',') || 'none'}.`);
    }
    return { identity: this.identity, toolCount: observed.length };
  }
}
