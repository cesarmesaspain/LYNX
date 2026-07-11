import { greet } from './utils/greet.js';
import { calculate } from './math/calc.js';

export function main(): string {
  const result = calculate(5, 3);
  return greet(`Result: ${result}`);
}
