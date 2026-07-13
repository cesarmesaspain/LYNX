import { describe, expect, it } from 'vitest';
import { webSocketScript } from '../../../src/server/dashboard/scripts/websocket.js';

describe('webSocketScript', () => {
  it('formats live dashboard values using the selected locale', () => {
    const script = webSocketScript();

    expect(script).toContain("toLocaleString(isSpanish ? 'es-ES' : 'en-US')");
    expect(script).toContain('fmt(totalTokens)');
    expect(script).toContain('fmt(c.nodes)');
  });
});
