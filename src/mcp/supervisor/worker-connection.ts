import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { JsonRpcValue } from './protocol-router.js';
import { JsonRpcLineFramer } from './json-rpc-lines.js';

export interface WorkerConnectionHandlers {
  onMessage: (generationId: string, message: JsonRpcValue) => void;
  onDiagnostic?: (generationId: string, text: string) => void;
  onFailure: (generationId: string, error: Error) => void;
  maxLineBytes?: number;
}

export class McpWorkerConnection {
  private readonly framer: JsonRpcLineFramer;
  private failed = false;
  private retiring = false;

  constructor(
    readonly generationId: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly handlers: WorkerConnectionHandlers,
  ) {
    this.framer = new JsonRpcLineFramer(handlers.maxLineBytes);
    child.stdout.on('data', chunk => this.consume(chunk));
    child.stderr.on('data', chunk => handlers.onDiagnostic?.(generationId, chunk.toString('utf8')));
    child.stdout.on('end', () => {
      try { this.framer.end(); } catch (error) { this.fail(error); }
    });
    child.on('error', error => this.fail(error));
    child.on('exit', (code, signal) => {
      if (!this.retiring && code !== 0 && !this.failed) this.fail(new Error(`MCP worker exited before retirement (code=${code}, signal=${signal ?? 'none'}).`));
    });
  }

  async send(message: JsonRpcValue): Promise<void> {
    if (this.failed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new Error(`MCP worker is not writable: ${this.generationId}.`);
    }
    const line = JsonRpcLineFramer.encode(message);
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, error => error ? reject(error) : resolve());
    });
  }

  retire(): void {
    this.retiring = true;
    if (!this.child.stdin.destroyed) this.child.stdin.end();
  }

  terminate(): void {
    this.retiring = true;
    this.child.kill();
  }

  private consume(chunk: Buffer | string): void {
    if (this.failed) return;
    try {
      for (const message of this.framer.push(chunk)) this.handlers.onMessage(this.generationId, message);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.handlers.onFailure(this.generationId, error instanceof Error ? error : new Error(String(error)));
  }
}
