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

describe('runtime configuration defaults', () => {
  it('returns independent nested defaults for every read', () => {
    const home = path.join(os.tmpdir(), 'lynx-runtime-defaults-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    try {
      withLynxHome(home, () => {
        const first = readLynxConfig();
        first.decision_llm!.max_calls_per_hour = 777;
        first.agent_response!.length = 'long';

        const second = readLynxConfig();

        expect(second.decision_llm?.max_calls_per_hour).toBe(10);
        expect(second.agent_response?.length).toBe('short');
        expect(second.decision_llm).not.toBe(first.decision_llm);
        expect(second.agent_response).not.toBe(first.agent_response);
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('runtime configuration updates', () => {
  it('preserves zero as a valid decision LLM hourly limit', () => {
    const home = path.join(os.tmpdir(), 'lynx-runtime-zero-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    try {
      withLynxHome(home, () => {
        upsertLynxConfig({ decision_llm: { mode: 'adaptive', max_calls_per_hour: 0 } });

        expect(readLynxConfig().decision_llm).toEqual({ mode: 'adaptive', max_calls_per_hour: 0 });
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls back for invalid numeric settings and clamps configured limits', () => {
    const home = path.join(os.tmpdir(), 'lynx-runtime-bounds-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    try {
      withLynxHome(home, () => {
        fs.mkdirSync(home, { recursive: true });
        const configPath = path.join(home, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify({
          decision_llm: { mode: 'adaptive', max_calls_per_hour: 'invalid' },
          savings_pricing: { avoided_input_usd_per_1m: 'invalid' },
        }));

        expect(readLynxConfig().decision_llm?.max_calls_per_hour).toBe(10);
        expect(readLynxConfig().savings_pricing?.avoided_input_usd_per_1m).toBe(0);

        for (const legacyFalsyValue of [null, false, '', '0']) {
          fs.writeFileSync(configPath, JSON.stringify({
            decision_llm: { mode: 'adaptive', max_calls_per_hour: legacyFalsyValue },
          }));
          expect(readLynxConfig().decision_llm?.max_calls_per_hour).toBe(10);
        }

        fs.writeFileSync(configPath, JSON.stringify({
          decision_llm: { mode: 'adaptive', max_calls_per_hour: -5 },
          savings_pricing: { avoided_input_usd_per_1m: 5000 },
        }));

        expect(readLynxConfig().decision_llm?.max_calls_per_hour).toBe(0);
        expect(readLynxConfig().savings_pricing?.avoided_input_usd_per_1m).toBe(1000);
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

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
