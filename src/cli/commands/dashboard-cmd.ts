import { findNearestProject } from '../../discovery/project-scanner.js';
import { runBenchmark } from '../benchmark.js';
import { startDashboard } from '../../server/dashboard/index.js';

export function cmdDashboard(): void {
  const server = startDashboard();
  console.error(`Dashboard: http://localhost:9191`);
  const detected = findNearestProject(process.cwd());
  if (detected) {
    runBenchmark([detected.rootPath, '--name', detected.name]).catch(() => {});
  }
  process.on('SIGINT', () => { server.close(); process.exit(0); });
  process.on('SIGTERM', () => { server.close(); process.exit(0); });
  setInterval(() => {}, 60_000).unref();
}
