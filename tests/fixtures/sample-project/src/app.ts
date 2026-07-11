import { main } from './index.js';
import { Calculator } from './math/calc.js';

export function run(): void {
  console.log(main());
  const calc = new Calculator();
  console.log(calc.multiply(4, 5));
}
