import { runInstall } from '../../install/index.js';

export async function cmdInstall(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const planOnly = args.includes('--plan');
  const autoIndex = !args.includes('--no-auto-index');
  const strict = args.includes('--strict');
  await runInstall({ dryRun, planOnly, autoIndex, strict });
}
