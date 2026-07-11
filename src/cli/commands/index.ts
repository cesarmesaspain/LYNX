import { cmdIndex } from './index-cmd.js';
import { cmdWatch } from './watch-cmd.js';
import { cmdStatus } from './status-cmd.js';
import { cmdBrief } from './brief-cmd.js';
import { cmdDetect } from './detect-cmd.js';
import { cmdInstall } from './install-cmd.js';
import { cmdConfig } from './config-cmd.js';
import { cmdInit } from './init-cmd.js';
import { cmdDoctor } from './doctor-cmd.js';
import { cmdUsage } from './usage-cmd.js';
import { cmdBenchmark } from './benchmark-cmd.js';
import { cmdReport } from './report-cmd.js';
import { cmdDashboard } from './dashboard-cmd.js';
import { cmdHookAugment } from './hook-augment-cmd.js';
import { cmdUninstall } from './uninstall-cmd.js';
import { cmdServe } from './serve-cmd.js';
import { cmdLicense } from './license-cmd.js';
import { cmdMetrics } from './metrics-cmd.js';
import { cmdAB } from './ab-cmd.js';
import { cmdAgentAB } from './agent-ab-cmd.js';
import { cmdUpgrade } from './upgrade-cmd.js';

export async function dispatchCommand(command: string, args: string[]): Promise<void> {
  switch (command) {
    case 'index':        return cmdIndex(args);
    case 'watch':        return cmdWatch(args);
    case 'status':       cmdStatus(args); return;
    case 'brief':        await cmdBrief(args); return;
    case 'detect':       cmdDetect(args); return;
    case 'install':      await cmdInstall(args); return;
    case 'config':       cmdConfig(args); return;
    case 'init':         cmdInit(args); return;
    case 'doctor':       await cmdDoctor(); return;
    case 'usage':        cmdUsage(args); return;
    case 'benchmark':    await cmdBenchmark(args); return;
    case 'ab':           await cmdAB(args); return;
    case 'agent-ab':     await cmdAgentAB(args); return;
    case 'report':       cmdReport(args); return;
    case 'dashboard':    cmdDashboard(); return;
    case 'hook-augment': await cmdHookAugment(); return;
    case 'uninstall':    cmdUninstall(args); return;
    case 'license':      cmdLicense(args); return;
    case 'metrics':      cmdMetrics(args); return;
    case 'upgrade':      await cmdUpgrade(args); return;
    case 'serve':
    case undefined:      await cmdServe(); return;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Commands: index, watch, detect, status, brief, install, init, doctor, config, usage, benchmark, ab, agent-ab, report, dashboard, license, metrics, upgrade, uninstall, serve');
      process.exit(1);
  }
}
