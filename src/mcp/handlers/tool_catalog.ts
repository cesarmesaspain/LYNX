const CORE = ['pack_context', 'search_graph', 'get_code_snippet', 'trace_path', 'find_tests', 'detect_changes', 'assess_impact', 'list_projects', 'tool_catalog'];

export async function handleToolCatalog(): Promise<unknown> {
  return {
    profile: process.env.LYNX_TOOL_PROFILE || 'core',
    core_tools: CORE,
    advanced_profile: 'Set LYNX_TOOL_PROFILE=advanced and restart the MCP client to expose the full catalog.',
    advanced_when: {
      architecture: ['get_architecture', 'query_graph', 'analyze_hotspots'],
      maintenance: ['find_dead_code', 'compare_runs', 'smart_review'],
      indexing: ['index_repository', 'watch_project', 'index_status'],
      cross_project: ['semantic_search', 'search_code', 'batch_get_code'],
    },
  };
}
