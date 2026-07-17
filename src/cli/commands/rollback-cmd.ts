import { rollbackDistribution } from '../../install/distribution.js';
import { verifyMcpServer } from '../../install/mcp-verify.js';
import { isPkg } from '../../paths.js';

async function acceptMcpRuntime(installedPath: string): Promise<void> {
  const verification = await verifyMcpServer(installedPath, ['serve']);
  if (!verification.ok) {
    const missing = verification.missing.length ? ` Missing: ${verification.missing.join(', ')}.` : '';
    throw new Error(`Restored distribution failed MCP acceptance (${verification.discovered}/${verification.expected}).${missing}`);
  }
}

export async function cmdRollback(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: lynx rollback\n\nRestore the last accepted packaged LYNX distribution and verify its MCP runtime.');
    return;
  }
  if (!isPkg()) {
    throw new Error('Distribution rollback is unavailable for a source-linked LYNX checkout. Use git/build tooling for source rollback.');
  }

  await rollbackDistribution(process.execPath, acceptMcpRuntime);
  console.log('LYNX rollback complete. The restored distribution passed MCP acceptance.');
}
