/*
 * resolve/constants.ts — Shared constants for the resolver passes.
 */

export const callableKinds = new Set(['Function', 'Method']);
export const symbolKinds = new Set(['Function', 'Method', 'Class', 'Interface', 'Variable', 'Type', 'Enum']);
export const typeKinds = new Set(['Class', 'Interface', 'Type', 'Enum']);
// Hard-skip: names that are nearly always useless as graph edges.
// These are JS/TS built-ins, DOM globals, and JSX/React prop patterns.
// Generic names like 'add', 'get', 'load' go in lowSignalGlobalUsage instead —
// they still create edges when there's structural evidence (import, same-file).
export const usageSkip = new Set([
  'arguments', 'console', 'exports', 'module', 'require', 'undefined',
  'window', 'document', 'process', 'Promise', 'Array', 'Object', 'String',
  'Number', 'Boolean', 'JSON', 'Math', 'Date', 'Error', 'Map', 'Set',
  'RegExp', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Symbol',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'ArrayBuffer', 'SharedArrayBuffer',
  'DataView', 'Atomics', 'BigInt', 'Infinity', 'NaN', 'isNaN', 'isFinite',
  'parseInt', 'parseFloat', 'encodeURI', 'encodeURIComponent',
  'decodeURI', 'decodeURIComponent', 'eval',
  // JSX/React prop patterns — noise, not architectural signal
  'className', 'style', 'children', 'href', 'src', 'alt', 'role', 'ariaLabel',
  'onClick', 'onChange', 'onSubmit', 'onFocus', 'onBlur', 'onKeyDown',
  'onKeyUp', 'onMouseEnter', 'onMouseLeave', 'onScroll', 'onLoad', 'onError',
  'key', 'ref', 'type', 'id', 'title', 'placeholder', 'disabled', 'readOnly',
  'defaultValue', 'defaultChecked', 'tabIndex', 'autoFocus', 'autoComplete',
]);
// Low-signal names: skip unique-name heuristic (strategy 3) and get reduced
// confidence on same-package resolution (strategy 4). But they STILL create
// edges when there's structural evidence — import-map (strategy 1) or same-file
// (strategy 2) — at full confidence (0.85).
export const lowSignalGlobalUsage = new Set([
  // Nouns — common identifiers across many domains
  'auth', 'config', 'data', 'description', 'email', 'error', 'event', 'id',
  'input', 'item', 'key', 'label', 'message', 'metadata', 'name', 'node',
  'options', 'path', 'request', 'response', 'result', 'source', 'status',
  'target', 'text', 'title', 'type', 'value', 'state', 'params', 'props',
  'context', 'callback', 'handler', 'logger', 'store', 'cache', 'buffer',
  'token', 'session', 'payload', 'header', 'body',
  // Verbs — common action names
  'load', 'init', 'setup', 'start', 'stop', 'close', 'open', 'read', 'write',
  'get', 'set', 'create', 'update', 'delete', 'remove', 'add', 'clear', 'reset',
  'run', 'execute', 'handle', 'process', 'main', 'parse', 'format',
  'validate', 'convert', 'transform', 'render', 'refresh', 'build', 'destroy',
  'enable', 'disable', 'show', 'hide', 'send', 'receive', 'connect', 'disconnect',
  'readString', 'toString', 'toJSON', 'valueOf', 'hasOwnProperty',
  'getter', 'setter', 'builder', 'factory', 'helper', 'wrapper',
  // Adjectives/modifiers
  'active', 'enabled', 'disabled', 'visible', 'hidden', 'loading', 'pending',
  'ready', 'done', 'success', 'failed', 'empty', 'default',
]);
