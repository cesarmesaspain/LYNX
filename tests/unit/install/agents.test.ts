import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getLynxCommand } from '../../../src/install/agents.js';

describe('getLynxCommand', () => {
  it('returns an executable MCP command from a source checkout', () => {
    const { command, args } = getLynxCommand();

    expect(fs.existsSync(command)).toBe(true);
    expect(args.at(-1)).toBe('serve');
    expect(args.some(arg => arg.endsWith('cli.ts') || arg.endsWith('cli.js'))).toBe(true);
    for (const arg of args.filter(arg => arg.endsWith('.ts') || arg.endsWith('.js') || arg.endsWith('.mjs'))) {
      expect(fs.existsSync(arg)).toBe(true);
    }
  });
});
