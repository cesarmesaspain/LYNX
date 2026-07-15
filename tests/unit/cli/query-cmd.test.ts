import { afterEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
  analyzeHotspots: vi.fn(),
  findDeadCode: vi.fn(),
  findTests: vi.fn(),
  getCodeSnippet: vi.fn(),
  searchGraph: vi.fn(),
  semanticSearch: vi.fn(),
  tracePath: vi.fn(),
}));

vi.mock('../../../src/mcp/handlers/search_graph.js', () => ({ handleSearchGraph: handlers.searchGraph }));
vi.mock('../../../src/mcp/handlers/trace_path.js', () => ({ handleTracePath: handlers.tracePath }));
vi.mock('../../../src/mcp/handlers/get_code_snippet.js', () => ({ handleGetCodeSnippet: handlers.getCodeSnippet }));
vi.mock('../../../src/mcp/handlers/find_tests.js', () => ({ handleFindTests: handlers.findTests }));
vi.mock('../../../src/mcp/handlers/find_dead_code.js', () => ({ handleFindDeadCode: handlers.findDeadCode }));
vi.mock('../../../src/mcp/handlers/analyze_hotspots.js', () => ({ handleAnalyzeHotspots: handlers.analyzeHotspots }));
vi.mock('../../../src/mcp/handlers/semantic_search.js', () => ({ handleSemanticSearch: handlers.semanticSearch }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('query CLI commands', () => {
  it.each([
    ['search', ['LYNX', 'timestamp', '25'], handlers.searchGraph, { project: 'LYNX', query: 'timestamp', limit: 25, include_snippets: true }],
    ['trace', ['LYNX', 'store.time.parseStoredTimestamp', 'inbound', '4'], handlers.tracePath, { project: 'LYNX', function_name: 'store.time.parseStoredTimestamp', direction: 'inbound', depth: 4 }],
    ['snippet', ['LYNX', 'store.time.utcTodayDateString'], handlers.getCodeSnippet, { project: 'LYNX', qualified_name: 'store.time.utcTodayDateString' }],
    ['tests', ['LYNX', 'store.time.utcTodayDateString'], handlers.findTests, { project: 'LYNX', qualified_name: 'store.time.utcTodayDateString' }],
    ['dead', ['LYNX', '12'], handlers.findDeadCode, { project: 'LYNX', limit: 12 }],
    ['hotspots', ['LYNX'], handlers.analyzeHotspots, { project: 'LYNX' }],
    ['semantic', ['LYNX', 'timestamp helpers', '15'], handlers.semanticSearch, { project: 'LYNX', query: 'timestamp helpers', limit: 15 }],
  ] as const)('forwards %s arguments and prints JSON', async (command, args, handler, expectedArgs) => {
    const result = { command };
    handler.mockResolvedValueOnce(result);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { dispatchCommand } = await import('../../../src/cli/commands/registry.js');
    await dispatchCommand(command, [...args]);

    expect(handler).toHaveBeenCalledWith(expectedArgs);
    expect(stdout).toHaveBeenCalledWith(`${JSON.stringify(result)}\n`);
  });
});
