import { runInit } from '../../install/index.js';

export function cmdInit(args: string[]): void {
  const dryRun = args.includes('--dry-run');
  runInit(dryRun);
}
