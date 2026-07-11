import { runUninstall } from '../../install/index.js';

export function cmdUninstall(args: string[]): void {
  const dryRun = args.includes('--dry-run');
  runUninstall(dryRun);
}
