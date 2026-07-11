/*
 * mcp-verify.ts — Runtime MCP handshake verification for onboarding.
 */

import { spawn } from 'node:child_process';
import * as os from 'node:os';
import { TOOLS } from '../mcp/tools.js';

export interface McpVerification {
  ok: boolean;
  expected: number;
  discovered: number;
  missing: string[];
  error?: string;
}

const VERIFY_TIMEOUT_MS = 8_000;

export function verifyMcpServer(command: string, args: string[]): Promise<McpVerification> {
  return new Promise((resolve) => {
    const expectedNames = TOOLS.map((tool) => tool.name);
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timeout: NodeJS.Timeout | undefined;

    const finish = (result: McpVerification) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd: os.tmpdir(),
        env: { ...process.env, LYNX_VERIFY: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ expected: expectedNames.length, discovered: 0, missing: expectedNames, ok: false, error: String(error) });
      return;
    }

    timeout = setTimeout(() => {
      child.kill();
      finish({
        expected: expectedNames.length,
        discovered: 0,
        missing: expectedNames,
        ok: false,
        error: 'MCP handshake timed out',
      });
    }, VERIFY_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      finish({ expected: expectedNames.length, discovered: 0, missing: expectedNames, ok: false, error: String(error) });
    });
    child.on('close', () => {
      const responses = stdout.split('\n').flatMap((line) => {
        try { return [JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name?: string }> } }]; }
        catch { return []; }
      });
      const tools = responses.find((response) => response.id === 2)?.result?.tools || [];
      const names = new Set(tools.map((tool) => tool.name).filter((name): name is string => Boolean(name)));
      const missing = expectedNames.filter((name) => !names.has(name));
      finish({
        expected: expectedNames.length,
        discovered: names.size,
        missing,
        ok: missing.length === 0 && names.size === expectedNames.length,
        ...(names.size === 0 && stderr ? { error: stderr.trim() } : {}),
      });
    });

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    child.stdin.end();
  });
}
