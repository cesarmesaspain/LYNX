import { cmdAgentABBenchmark } from '../agent-ab/benchmark.js';

export async function cmdAgentAB(args: string[]): Promise<void> {
  await cmdAgentABBenchmark(args);
}
