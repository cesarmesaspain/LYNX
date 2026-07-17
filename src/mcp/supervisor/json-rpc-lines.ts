import type { JsonRpcValue } from './protocol-router.js';

export class JsonRpcLineFramer {
  private buffered = '';

  constructor(private readonly maxLineBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) throw new Error('JSON-RPC line limit must be positive.');
  }

  push(chunk: Buffer | string): JsonRpcValue[] {
    this.buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const messages: JsonRpcValue[] = [];
    let newline = this.buffered.indexOf('\n');
    while (newline !== -1) {
      const raw = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (Buffer.byteLength(raw) > this.maxLineBytes) throw new Error('JSON-RPC line exceeds the configured byte limit.');
      const line = raw.trim();
      if (line) messages.push(this.parse(line));
      newline = this.buffered.indexOf('\n');
    }
    if (Buffer.byteLength(this.buffered) > this.maxLineBytes) throw new Error('JSON-RPC partial line exceeds the configured byte limit.');
    return messages;
  }

  end(): void {
    if (this.buffered.trim()) throw new Error('JSON-RPC stream ended with a truncated line.');
    this.buffered = '';
  }

  static encode(message: JsonRpcValue, maxLineBytes = 1024 * 1024): string {
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line) > maxLineBytes) throw new Error('JSON-RPC output exceeds the configured byte limit.');
    return `${line}\n`;
  }

  private parse(line: string): JsonRpcValue {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new Error('JSON-RPC stream contained malformed JSON.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON-RPC message must be an object.');
    return parsed as JsonRpcValue;
  }
}
