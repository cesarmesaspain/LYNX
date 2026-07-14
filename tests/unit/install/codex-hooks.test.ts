import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installCodexHook } from '../../../src/install/hooks.js';

const tempDirs: string[] = [];

function makeConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-codex-hook-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Codex SessionStart installation', () => {
  it('installs a guarded fast index command for new chats in config.toml', () => {
    const configDir = makeConfigDir();

    installCodexHook(configDir, false);

    const config = fs.readFileSync(path.join(configDir, 'config.toml'), 'utf-8');
    expect(config).toContain('matcher = "startup"');
    expect(config).toContain('lynx index \\"$PWD\\" --mode fast');
    expect(config).toContain('[ -f \\"$PWD/CLAUDE.md\\" ] || [ -f \\"$PWD/AGENTS.md\\" ]');
  });

  it('replaces the legacy reminder when hooks.json is already present', () => {
    const configDir = makeConfigDir();
    const hooksPath = path.join(configDir, 'hooks.json');
    fs.writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: 'startup',
          hooks: [{ type: 'command', command: 'echo "LYNX code discovery protocol"' }],
        }],
      },
    }));

    installCodexHook(configDir, false);

    const config = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as {
      hooks: { SessionStart: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(config.hooks.SessionStart).toEqual([{
      matcher: 'startup',
      hooks: [{
        type: 'command',
        command: 'if [ -f "$PWD/CLAUDE.md" ] || [ -f "$PWD/AGENTS.md" ]; then lynx index "$PWD" --mode fast --incremental; fi',
      }],
    }]);
  });
});
