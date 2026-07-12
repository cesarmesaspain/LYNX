// This function is never called — should be detected as dead code
export function deadFunction(): string {
  return 'nobody calls me';
}

// This is called from within the same file — should be detected because the caller is unused
export function unusedWithHelper(): number {
  return helperDouble(21);
}

function helperDouble(n: number): number {
  return n * 2;
}

// Exported but also never imported anywhere
export function alsoDead(): boolean {
  return true;
}
