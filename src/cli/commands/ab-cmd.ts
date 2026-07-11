import { cmdABBenchmark } from '../ab-benchmark.js';

export async function cmdAB(args: string[]): Promise<void> {
  await cmdABBenchmark(args);
}
