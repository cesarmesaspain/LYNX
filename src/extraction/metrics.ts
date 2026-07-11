/*
 * metrics.ts — Code complexity metrics computed from AST.
 *
 * Extracted during the tree-sitter walk and stored on function/method nodes.
 * Implements: cyclomatic complexity, cognitive complexity, loop depth,
 * transitive loop depth (propagated post-extraction), linear_scan_in_loop,
 * alloc_in_loop, recursion detection.
 */

/**
 * Cyclomatic complexity: count of decision points + 1.
 *
 * Decision points in TypeScript:
 *   if, else if, for, while, do-while, switch/case (each case),
 *   catch, ternary (?:), &&, ||, ??, optional chain (?.) in conditional position
 */
export interface ComplexityMetrics {
  cyclomatic: number;
  cognitive: number;
  lineCount: number;
  loopCount: number;
  loopDepth: number;
  linearScanInLoop: number;
  allocInLoop: number;
  recursive: boolean;
  recursionInLoop: boolean;
  unguardedRecursion: boolean;
  paramCount: number;
  maxAccessDepth: number;
}

export function defaultMetrics(): ComplexityMetrics {
  return {
    cyclomatic: 1,
    cognitive: 0,
    lineCount: 0,
    loopCount: 0,
    loopDepth: 0,
    linearScanInLoop: 0,
    allocInLoop: 0,
    recursive: false,
    recursionInLoop: false,
    unguardedRecursion: false,
    paramCount: 0,
    maxAccessDepth: 0,
  };
}

// Node types that contribute to cyclomatic complexity
const DECISION_NODES = new Set([
  'if_statement',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'switch_case',
  'catch_clause',
  'ternary_expression',
]);

// Node types that are loops
const LOOP_NODES = new Set([
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
]);

// Node types that add cognitive complexity nesting weight
const NESTING_NODES = new Set([
  'if_statement',
  'else_clause',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'catch_clause',
  'arrow_function',
  'function_expression',
  'function_declaration',
  'method_definition',
]);

// Linear scan method names
const LINEAR_SCAN_METHODS = new Set([
  'find',
  'findIndex',
  'indexOf',
  'includes',
  'some',
  'every',
  'filter',
  'search',
  'match',
  'test',
]);

// Allocation method names
const ALLOC_METHODS = new Set([
  'push',
  'unshift',
  'concat',
  'map',
  'slice',
  'filter',
  'reduce',
  'fill',
  'Array',
  'Object',
  'Set',
  'Map',
]);

/**
 * Check if a node contains a self-referencing call (recursion).
 * callNames should be the names of calls found in the function body.
 */
export function detectRecursion(
  functionName: string,
  callNames: string[],
  insideLoop: boolean
): { recursive: boolean; recursionInLoop: boolean; unguardedRecursion: boolean } {
  const hasSelfCall = callNames.includes(functionName);
  return {
    recursive: hasSelfCall,
    recursionInLoop: hasSelfCall && insideLoop,
    unguardedRecursion: hasSelfCall, // We don't have conditional guard detection yet
  };
}

/** Count iterations of a "true" cycle in label propagation */
export function computeTransitiveLoopDepth(
  directLoopDepth: number,
  calleeLoopDepths: number[]
): number {
  if (calleeLoopDepths.length === 0) return directLoopDepth;
  return Math.max(directLoopDepth, ...calleeLoopDepths);
}

/**
 * Check whether a node is a decision point for cyclomatic complexity.
 */
export function isDecisionNode(nodeType: string): boolean {
  return DECISION_NODES.has(nodeType);
}

/**
 * Check whether a node introduces a loop.
 */
export function isLoopNode(nodeType: string): boolean {
  return LOOP_NODES.has(nodeType);
}

/**
 * Check whether a node increases cognitive nesting weight.
 */
export function isNestingNode(nodeType: string): boolean {
  return NESTING_NODES.has(nodeType);
}

/**
 * Check whether a method call name is a linear scan (O(n) search).
 */
export function isLinearScan(methodName: string): boolean {
  return LINEAR_SCAN_METHODS.has(methodName);
}

/**
 * Check whether a method call name is an allocation.
 */
export function isAllocation(methodName: string): boolean {
  return ALLOC_METHODS.has(methodName);
}
