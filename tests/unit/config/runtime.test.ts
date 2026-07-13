import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lynxHome, readLynxConfig, upsertLynxConfig, withLynxHome } from '../../../src/config/runtime.js';

describe('withLynxHome', () => {
  it('isolates concurrent async operations without mutating process.env', async () => {
    const original = process.env.LYNX_HOME;
    const [first, second] = await Promise.all([
      withLynxHome('/tmp/lynx-first', async () => {
        await Promise.resolve();
        return lynxHome();
      }),
      withLynxHome('/tmp/lynx-second', async () => {
        await Promise.resolve();
        return lynxHome();
      }),
    ]);

    expect(first).toBe('/tmp/lynx-first');
    expect(second).toBe('/tmp/lynx-second');
    expect(process.env.LYNX_HOME).toBe(original);
  });
});

describe('runtime configuration updates', () => {
  it('merges nested settings instead of overwriting saved provider keys', () => {
    const home = path.join(os.tmpdir(), `lynx-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      withLynxHome(home, () => {
        upsertLynxConfig({ api_keys: { deepseek: 'first-key' } });
        upsertLynxConfig({ api_keys: { vps_key: 'second-key' }, project_brief: { llm_enrichment: true }, decision_llm: { mode: 'adaptive', max_calls_per_hour: 7 }, mcp_tool_profile: 'core' });

        expect(readLynxConfig().api_keys).toEqual({ deepseek: 'first-key', vps_key: 'second-key' });
        expect(readLynxConfig().project_brief?.llm_enrichment).toBe(true);
        expect(readLynxConfig().decision_llm).toEqual({ mode: 'adaptive', max_calls_per_hour: 7 });
        expect(readLynxConfig().mcp_tool_profile).toBe('core');
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
