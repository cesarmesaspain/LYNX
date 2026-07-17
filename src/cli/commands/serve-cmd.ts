import { findNearestProject } from '../../discovery/project-scanner.js';
import { runServer } from '../../mcp/server.js';
import { isInternalMcpWorker, runSupervisedServer } from '../../mcp/supervisor/supervised-server.js';
import { readLynxConfig } from '../../config/runtime.js';
import { getLynxCommand } from '../../install/agents.js';
import { ensureDashboardService } from '../../server/dashboard/service.js';

export async function cmdServe(): Promise<void> {
  if (isInternalMcpWorker()) {
    await runServer();
    return;
  }
  const cfg = readLynxConfig();
  if (cfg.enabled && cfg.auto_dashboard) {
    const { command, args } = getLynxCommand();
    console.error(await ensureDashboardService(command, args));
  }
  const detected = findNearestProject(process.cwd());
  if (detected) {
    console.error(`Auto-detected project: ${detected.name} (${detected.language})`);
    if (cfg.auto_index) {
      console.error(`Auto-index is enabled; LYNX will refresh this project in the background.`);
    } else {
      console.error(`Run: npx lynx index   to index it`);
      console.error(`Run: npx lynx watch   to watch for changes`);
    }
  }

  // runServer starts: MCP JSON-RPC over stdio + dashboard + auto-index + auto-watch
  await runSupervisedServer();
}
