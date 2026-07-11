import { runBenchmark } from '../benchmark.js';

export async function cmdBenchmark(args: string[]): Promise<void> {
  // --no-llm forces deterministic mode (skip semantic reranking)
  if (args.includes('--no-llm')) {
    process.env.LYNX_NO_LLM = '1';
  }
  await runBenchmark(args);
}
