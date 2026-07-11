import { findNearestProject } from '../../discovery/project-scanner.js';
import { runServer } from '../../mcp/server.js';
import { readLynxConfig } from '../../config/runtime.js';

export async function cmdServe(): Promise<void> {
  const detected = findNearestProject(process.cwd());
  if (detected) {
    console.error(`Auto-detected project: ${detected.name} (${detected.language})`);
    const cfg = readLynxConfig();
    if (cfg.auto_index) {
      console.error(`Auto-index is enabled; LYNX will refresh this project in the background.`);
    } else {
      console.error(`Run: npx lynx index   to index it`);
      console.error(`Run: npx lynx watch   to watch for changes`);
    }
  }
  await runServer();
}
