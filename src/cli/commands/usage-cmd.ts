import {
  clearUsageEvents,
  exportUsageEvents,
  summarizeUsage,
  usageLogPath,
} from '../../usage/metrics.js';

export function cmdUsage(args: string[]): void {
  const sub = args[0];
  if (sub === 'clear') {
    const project = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    const removed = clearUsageEvents(project);
    console.log(`Removed ${removed} usage event(s).`);
    return;
  }
  if (sub === 'export') {
    const outIdx = args.indexOf('--out');
    const outPath = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : 'lynx-usage-export.json';
    const project = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    const count = exportUsageEvents(outPath, project);
    console.log(`Exported ${count} usage event(s) to ${outPath}.`);
    return;
  }
  const project = sub && !sub.startsWith('--') ? sub : undefined;
  const summary = summarizeUsage(project, 2000);
  console.log(JSON.stringify({ ...summary, log: usageLogPath() }, null, 2));
}
