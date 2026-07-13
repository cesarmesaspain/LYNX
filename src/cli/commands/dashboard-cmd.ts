import { findNearestProject } from '../../discovery/project-scanner.js';
import { runBenchmark } from '../benchmark.js';
import { isDashboardListening, startDashboard, stopDashboard } from '../../server/dashboard/index.js';

export function cmdDashboard(args: string[] = []): void {
  const serviceMode = args.includes('--service');
  startDashboard();
  if (!serviceMode) {
    console.error(`Dashboard: http://localhost:9191`);
    const detected = findNearestProject(process.cwd());
    if (detected) {
      runBenchmark([detected.rootPath, '--name', detected.name]).catch(() => {});
    }
  }
  // In service mode this keeps the dashboard available after temporary port
  // conflicts, without depending on an MCP client's stdin lifecycle.
  const healthLoop = setInterval(() => {
    if (!isDashboardListening()) startDashboard();
  }, serviceMode ? 10_000 : 60_000);
  if (!serviceMode) healthLoop.unref();
  const shutdown = () => { clearInterval(healthLoop); stopDashboard(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
