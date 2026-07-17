import { spawn } from 'node:child_process';
import { getBuildIdentity } from '../../build-identity.js';
import { getLynxCommand } from '../../install/agents.js';
import { TOOLS } from '../tools.js';
import { JsonRpcLineFramer } from './json-rpc-lines.js';
import { McpSupervisorCore } from './supervisor-core.js';
import { McpWorkerConnection } from './worker-connection.js';

const WORKER_ENV = 'LYNX_MCP_INTERNAL_WORKER';

export function isInternalMcpWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WORKER_ENV] === '1';
}

export async function runSupervisedServer(): Promise<void> {
  const identity = getBuildIdentity();
  const generationId = `${identity.version}/${process.pid}/1`;
  let fatal: Error | null = null;
  const core = new McpSupervisorCore(
    message => process.stdout.write(JsonRpcLineFramer.encode(message)),
    error => {
      fatal = error;
      console.error(`LYNX MCP worker failed: ${error.message}`);
      process.stdin.pause();
    },
  );
  const { command, args } = getLynxCommand();
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, [WORKER_ENV]: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const worker = new McpWorkerConnection(generationId, child, {
    onMessage: (id, message) => core.handleWorkerMessage(id, message),
    onDiagnostic: (_id, text) => process.stderr.write(text),
    onFailure: (id, error) => core.handleWorkerFailure(id, error),
  });
  try {
    await core.prepareInitial(generationId, worker, {
      toolNames: TOOLS.map(tool => tool.name),
      ...(identity.distributionSha256 ? { distributionSha256: identity.distributionSha256 } : {}),
    });
  } catch (error) {
    worker.terminate();
    throw error;
  }

  const input = new JsonRpcLineFramer();
  process.stdin.on('data', async chunk => {
    if (fatal) return;
    try {
      for (const message of input.push(chunk)) await core.routeHost(message);
    } catch (error) {
      fatal = error instanceof Error ? error : new Error(String(error));
      console.error(`LYNX MCP supervisor input failed: ${fatal.message}`);
      worker.terminate();
      process.stdin.pause();
    }
  });
  process.stdin.on('end', () => worker.retire());
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
}
