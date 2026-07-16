import { readLynxConfig } from '../../config/runtime.js';
import { READ_ONLY_TOOL_NAMES, TOOLS } from '../tools.js';

const CORE = ['pack_context', 'search_graph', 'get_code_snippet', 'trace_path', 'find_tests', 'detect_changes', 'assess_impact', 'list_projects', 'tool_catalog', 'get_edge_evidence'];

export async function handleToolCatalog(): Promise<unknown> {
  const requestedProfile = process.env.LYNX_TOOL_PROFILE || readLynxConfig().mcp_tool_profile || 'full';
  const profile = requestedProfile === 'core' ? 'core' : 'full';
  const availableTools = (profile === 'core' ? TOOLS.filter(tool => CORE.includes(tool.name)) : TOOLS)
    .map(tool => ({
      name: tool.name,
      read_only: READ_ONLY_TOOL_NAMES.has(tool.name),
      destructive: tool.name === 'delete_project',
    }));
  return {
    profile,
    tool_count: availableTools.length,
    available_tools: availableTools,
    core_tools: CORE,
    advanced_profile: profile === 'full'
      ? 'Full catalog is active.'
      : 'Switch MCP catalog to Full in Settings and restart the MCP client to expose every tool.',
    advanced_when: {
      architecture: ['get_architecture', 'query_graph', 'analyze_hotspots'],
      maintenance: ['find_dead_code', 'compare_runs', 'smart_review'],
      indexing: ['index_repository', 'watch_project', 'index_status'],
      cross_project: ['semantic_search', 'search_code', 'batch_get_code'],
    },
  };
}
