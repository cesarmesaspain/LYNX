import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decayCounter, isProjectScopedAction, readCounterState } from './hook-augment.js';

const TEST_THRESHOLD = 4;
const TEST_DECAY = 2;

let tempHome: string;
let counterPath: string;

function readCounter(): { count: number; lastTouch: number; strictMode: boolean } {
  return JSON.parse(fs.readFileSync(counterPath, 'utf-8'));
}

function writeCounter(c: { count: number; lastTouch: number; strictMode: boolean }): void {
  fs.writeFileSync(counterPath, JSON.stringify(c) + '\n');
}

// Simulate the decay logic inline so we can test it without the hook harness
function simulateDecay(current: number, delta: number): number {
  return Math.max(0, current - delta);
}

function simulateTouch(current: number): number {
  return Math.min(current + 1, 999);
}

function simulateBlocked(count: number, threshold: number, strictMode: boolean): boolean {
  return strictMode && count > threshold;
}

// Inline the regexes from hook-augment.ts to test logic
const EXPLORATORY_BASH_RE = /(?:^|\s|[|&;`])(?:grep|rg|ag|ack|find|fd|locate|cat|head|tail|less|more|ls|tree|read|wc|file|stat|bat|rgrep)(?:\s|$)/;
const NON_EXPLORATORY_BASH_RE = /^(?:npm|yarn|pnpm|npx|node|bun|deno|tsc|vitest|jest|mocha|git\b(?!\s+grep)|docker|kubectl|curl|wget|echo|mkdir|rm|cp|mv|cd|pwd|export|source|python|go\b|cargo|make|gh\b|brew|pip|gem|cargo|rustc|java|javac|dotnet|cmake|meson|ninja|gcc|clang|g\+\+|cc)\b/;
const NON_CODE_EXTS = /\.(json|md|ya?ml|toml|lock|gitignore|env|txt|csv|xml|svg|css|html|htm|ini|cfg|conf|editorconfig|prettierrc|eslintrc|babelrc|dockerignore|npmignore|gitattributes)$/i;
const NON_CODE_FILES = /(?:^|\/|\s)(?:README|CHANGELOG|LICENSE|Makefile|Dockerfile|\.(?:env|git|docker|editorconfig|prettier|eslint|babel))$/im;

function isExploratoryBash(command: string, filePath: string): boolean {
  if (/^(?:npm run|npm test|npm ci|npm install|npx |node dist|node \S+\.(?:mjs|js|cjs))(?:$|\s)/.test(command.trim())) return false;
  if (NON_EXPLORATORY_BASH_RE.test(command.trim())) return false;
  if (filePath && (NON_CODE_EXTS.test(filePath) || NON_CODE_FILES.test(filePath))) return false;
  const cmdTarget = extractFileTarget(command);
  if (cmdTarget && (NON_CODE_EXTS.test(cmdTarget) || NON_CODE_FILES.test(cmdTarget))) return false;
  // Also catch non-code filenames without extensions (Dockerfile, Makefile, etc.)
  if (!cmdTarget && NON_CODE_FILES.test(command.trim())) return false;
  return EXPLORATORY_BASH_RE.test(command);
}

function extractFileTarget(command: string): string | null {
  const parts = command.trim().split(/\s+/);
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] && !parts[i].startsWith('-') && /[./]/.test(parts[i]) && /\.[a-z]{1,10}$/i.test(parts[i])) {
      return parts[i];
    }
  }
  return null;
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-hook-'));
  counterPath = path.join(tempHome, 'session-counter.json');
  writeCounter({ count: 0, lastTouch: Date.now(), strictMode: true });
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('decay counter logic', () => {
  it('decay subtracts exactly the decay amount', () => {
    expect(simulateDecay(5, 2)).toBe(3);
    expect(simulateDecay(6, 2)).toBe(4);
  });

  it('decay never goes below 0', () => {
    expect(simulateDecay(1, 2)).toBe(0);
    expect(simulateDecay(0, 2)).toBe(0);
  });

  it('touch increments by 1', () => {
    expect(simulateTouch(0)).toBe(1);
    expect(simulateTouch(3)).toBe(4);
  });

  it('block fires only when count > threshold AND strictMode=true', () => {
    expect(simulateBlocked(4, 4, true)).toBe(false);
    expect(simulateBlocked(5, 4, true)).toBe(true);
    expect(simulateBlocked(5, 4, false)).toBe(false);
  });

  it('decay then touch pattern: mixed usage stays below threshold', () => {
    let count = 0;
    const threshold = 4;
    // Simulate: grep, grep, grep, LYNX tool, grep, grep, LYNX tool, grep
    const sequence = [
      { op: 'touch' as const, expectedMax: 1 },
      { op: 'touch' as const, expectedMax: 2 },
      { op: 'touch' as const, expectedMax: 3 },
      { op: 'decay' as const, expectedAfter: 1 },   // 3 - 2 = 1
      { op: 'touch' as const, expectedMax: 2 },
      { op: 'touch' as const, expectedMax: 3 },
      { op: 'decay' as const, expectedAfter: 1 },
      { op: 'touch' as const, expectedMax: 2 },
    ];

    for (const step of sequence) {
      if (step.op === 'touch') {
        count = simulateTouch(count);
        expect(count).toBeLessThanOrEqual(step.expectedMax!);
      } else {
        count = simulateDecay(count, 2);
        expect(count).toBe(step.expectedAfter);
      }
      expect(simulateBlocked(count, threshold, true)).toBe(false);
    }
  });

  it('block triggers when no LYNX tools are used', () => {
    let count = 0;
    const threshold = 4;
    // 6 file-system tools in a row with no LYNX
    for (let i = 0; i < 6; i++) {
      count = simulateTouch(count);
    }
    expect(simulateBlocked(count, threshold, true)).toBe(true);
  });
});

describe('project-scoped strict state', () => {
  beforeEach(() => { process.env.LYNX_HOME = tempHome; });
  afterEach(() => { delete process.env.LYNX_HOME; });

  it('does not treat a file outside the project root as code discovery', () => {
    expect(isProjectScopedAction('read', { file_path: '/Users/admin/Desktop/LYNX/src/mcp/server.ts' }, '/Users/admin/Desktop/MENTESIA/NEW_WEBSITE', '/Users/admin/Desktop/MENTESIA/NEW_WEBSITE')).toBe(false);
    expect(isProjectScopedAction('read', { file_path: '/Users/admin/Desktop/MENTESIA/NEW_WEBSITE/src/app.ts' }, '/Users/admin/Desktop/MENTESIA/NEW_WEBSITE', '/Users/admin/Desktop/MENTESIA/NEW_WEBSITE')).toBe(true);
  });

  it('resets only the project that used a LYNX tool', () => {
    fs.writeFileSync(counterPath, JSON.stringify({ version: 2, projects: {
      alpha: { count: 4, lastTouch: Date.now(), strictMode: true, lynxUsed: false },
      beta: { count: 3, lastTouch: Date.now(), strictMode: true, lynxUsed: false },
    } }) + '\n');
    decayCounter('alpha');
    expect(readCounterState('alpha')).toMatchObject({ count: 0, lynxUsed: true });
    expect(readCounterState('beta')).toMatchObject({ count: 3, lynxUsed: false });
  });
});

describe('bash classification', () => {
  it('classifies grep as exploratory', () => {
    expect(isExploratoryBash('grep -r pattern src/', '')).toBe(true);
  });

  it('classifies find as exploratory', () => {
    expect(isExploratoryBash('find . -name "*.ts"', '')).toBe(true);
  });

  it('classifies cat of a .ts file as exploratory', () => {
    expect(isExploratoryBash('cat src/index.ts', '')).toBe(true);
  });

  it('classifies npm run as NOT exploratory', () => {
    expect(isExploratoryBash('npm run typecheck', '')).toBe(false);
  });

  it('classifies npm test as NOT exploratory', () => {
    expect(isExploratoryBash('npm test', '')).toBe(false);
  });

  it('classifies node dist/cli.js as NOT exploratory', () => {
    expect(isExploratoryBash('node dist/cli.js install', '')).toBe(false);
  });

  it('classifies git status as NOT exploratory', () => {
    expect(isExploratoryBash('git status', '')).toBe(false);
  });

  it('classifies git log as NOT exploratory', () => {
    expect(isExploratoryBash('git log --oneline', '')).toBe(false);
  });

  it('classifies echo as NOT exploratory', () => {
    expect(isExploratoryBash('echo hello', '')).toBe(false);
  });

  it('classifies docker build as NOT exploratory', () => {
    expect(isExploratoryBash('docker build .', '')).toBe(false);
  });

  it('classifies curl as NOT exploratory', () => {
    expect(isExploratoryBash('curl https://example.com', '')).toBe(false);
  });

  it('classifies tsc as NOT exploratory', () => {
    expect(isExploratoryBash('tsc --noEmit', '')).toBe(false);
  });

  it('classifies vitest as NOT exploratory', () => {
    expect(isExploratoryBash('vitest run', '')).toBe(false);
  });

  it('classifies head on code file as exploratory', () => {
    expect(isExploratoryBash('head -20 src/cli.ts', '')).toBe(true);
  });

  it('classifies tail on code file as exploratory', () => {
    expect(isExploratoryBash('tail -f app.log', '')).toBe(true);
  });

  it('classifies wc -l as exploratory', () => {
    expect(isExploratoryBash('wc -l src/*.ts', '')).toBe(true);
  });
});

describe('non-code file filtering', () => {
  it('cat session-counter.json is NOT exploratory (non-code target)', () => {
    expect(isExploratoryBash('cat ~/.lynx/session-counter.json', '')).toBe(false);
  });

  it('cat config.json is NOT exploratory', () => {
    expect(isExploratoryBash('cat config.json', '')).toBe(false);
  });

  it('cat CLAUDE.md is NOT exploratory', () => {
    expect(isExploratoryBash('cat CLAUDE.md', '')).toBe(false);
  });

  it('cat .env is NOT exploratory', () => {
    expect(isExploratoryBash('cat .env', '')).toBe(false);
  });

  it('cat README.md is NOT exploratory', () => {
    expect(isExploratoryBash('cat README.md', '')).toBe(false);
  });

  it('cat Dockerfile is NOT exploratory', () => {
    expect(isExploratoryBash('cat Dockerfile', '')).toBe(false);
  });

  it('cat src/index.ts IS exploratory', () => {
    expect(isExploratoryBash('cat src/index.ts', '')).toBe(true);
  });

  it('head .yaml file is NOT exploratory', () => {
    expect(isExploratoryBash('head .claude/settings.yaml', '')).toBe(false);
  });

  it('Read hook filePath for .json is caught', () => {
    expect(isExploratoryBash('', '/Users/admin/.lynx/config.json')).toBe(false);
  });

  it('Read hook filePath for .ts is NOT caught by non-code filter', () => {
    // Empty command means no exploratory grep/find, so it returns false from EXPLORATORY_BASH_RE
    // even for .ts files — Read has its own handler path
    expect(isExploratoryBash('', 'src/index.ts')).toBe(false);
  });
});

describe('file target extraction', () => {
  it('extracts file path from grep command', () => {
    expect(extractFileTarget('grep -rn "pattern" src/cli.ts')).toBe('src/cli.ts');
  });

  it('extracts file path from cat command', () => {
    expect(extractFileTarget('cat /Users/admin/.lynx/session-counter.json')).toBe('/Users/admin/.lynx/session-counter.json');
  });

  it('returns null for commands without file paths', () => {
    expect(extractFileTarget('npm run build')).toBeNull();
    expect(extractFileTarget('git status')).toBeNull();
  });

  it('node dist/cli.js is caught by NON_EXPLORATORY_BASH_RE before extractFileTarget', () => {
    // extractFileTarget would find dist/cli.js, but isExploratoryBash catches 'node' first
    expect(extractFileTarget('node dist/cli.js install')).toBe('dist/cli.js');
    expect(isExploratoryBash('node dist/cli.js install', '')).toBe(false);
  });

  it('skips flag arguments', () => {
    expect(extractFileTarget('grep -rn --include="*.ts" pattern')).toBeNull();
  });
});
