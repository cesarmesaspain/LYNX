import { runBenchmark } from '../benchmark.js';

export async function cmdBenchmark(args: string[]): Promise<void> {
  await runBenchmark(args);
}
