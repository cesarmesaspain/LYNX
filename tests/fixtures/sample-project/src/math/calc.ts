export function calculate(a: number, b: number): number {
  return add(a, b) * 2;
}

function add(a: number, b: number): number {
  return a + b;
}

export class Calculator {
  multiply(x: number, y: number): number {
    return x * y;
  }
}
