import { describe, expect, it } from 'vitest';
import { JsonRpcLineFramer } from '../../../src/mcp/supervisor/json-rpc-lines.js';

describe('bounded JSON-RPC line framing', () => {
  it('reassembles fragmented messages and emits multiple complete lines', () => {
    const framer = new JsonRpcLineFramer();
    expect(framer.push('{"jsonrpc":"2.0",')).toEqual([]);
    expect(framer.push('"id":1}\n{"jsonrpc":"2.0","method":"ping"}\n')).toEqual([
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', method: 'ping' },
    ]);
    framer.end();
  });

  it('rejects malformed, non-object and truncated messages', () => {
    expect(() => new JsonRpcLineFramer().push('{bad}\n')).toThrow('malformed JSON');
    expect(() => new JsonRpcLineFramer().push('[]\n')).toThrow('must be an object');
    const truncated = new JsonRpcLineFramer();
    truncated.push('{"jsonrpc":"2.0"}');
    expect(() => truncated.end()).toThrow('truncated line');
  });

  it('bounds both complete and partial input before parsing', () => {
    expect(() => new JsonRpcLineFramer(4).push('12345')).toThrow('partial line exceeds');
    expect(() => new JsonRpcLineFramer(4).push('12345\n')).toThrow('line exceeds');
  });

  it('encodes one bounded newline-delimited message', () => {
    expect(JsonRpcLineFramer.encode({ jsonrpc: '2.0', id: 1 })).toBe('{"jsonrpc":"2.0","id":1}\n');
    expect(() => JsonRpcLineFramer.encode({ value: 'too large' }, 4)).toThrow('output exceeds');
  });
});
