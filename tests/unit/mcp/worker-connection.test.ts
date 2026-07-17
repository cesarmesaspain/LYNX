import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { McpWorkerConnection } from '../../../src/mcp/supervisor/worker-connection.js';

function childFixture() {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

describe('MCP worker connection', () => {
  it('writes one bounded line and reassembles fragmented worker output', async () => {
    const child = childFixture();
    const messages: unknown[] = [];
    const failures: Error[] = [];
    const diagnostics: string[] = [];
    const connection = new McpWorkerConnection('v1', child, {
      onMessage: (_id, message) => messages.push(message),
      onFailure: (_id, error) => failures.push(error),
      onDiagnostic: (_id, text) => diagnostics.push(text),
    });
    const written: Buffer[] = [];
    child.stdin.on('data', (chunk: Buffer) => written.push(chunk));

    await connection.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    child.stdout.write('{"jsonrpc":"2.0",');
    child.stdout.write('"id":1,"result":{}}\n');
    child.stderr.write('worker diagnostic');

    expect(Buffer.concat(written).toString()).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
    expect(diagnostics).toEqual(['worker diagnostic']);
    expect(failures).toEqual([]);
  });

  it('fails once on malformed or oversized stdout and refuses later writes after process error', async () => {
    const child = childFixture();
    const failures: Error[] = [];
    const connection = new McpWorkerConnection('v1', child, {
      maxLineBytes: 8,
      onMessage: vi.fn(),
      onFailure: (_id, error) => failures.push(error),
    });
    child.stdout.write('123456789');
    child.emit('error', new Error('second failure'));
    expect(failures).toHaveLength(1);
    await expect(connection.send({ jsonrpc: '2.0' })).rejects.toThrow('not writable');
  });

  it('retires gracefully and supports forced termination', () => {
    const child = childFixture();
    const connection = new McpWorkerConnection('v1', child, {
      onMessage: vi.fn(),
      onFailure: vi.fn(),
    });
    connection.retire();
    expect(child.stdin.writableEnded).toBe(true);
    connection.terminate();
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
