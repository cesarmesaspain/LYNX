/* Tool schemas exposed to the two agent benchmark conditions. */

import type { AgentToolDefinition } from './types.js';

// ── Tool definitions ──────────────────────────────────────────

export function makeLynxTools(): AgentToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "search_graph",
        description:
          "Search the code knowledge graph. Returns matching symbols with their exact file path and line number — use this to locate where any function, class, or variable is defined.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Full-text search query" },
            label: {
              type: "string",
              description: "Filter: Function, Class, Method, etc.",
            },
            limit: { type: "number", description: "Max results (default 10)" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "trace_path",
        description:
          "Trace call graph from a function: find callers or callees.",
        parameters: {
          type: "object",
          properties: {
            function_name: {
              type: "string",
              description: "Function to trace from",
            },
            direction: {
              type: "string",
              enum: ["inbound", "outbound", "both"],
            },
            depth: { type: "number", description: "Search depth (default 3)" },
          },
          required: ["function_name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "explain_symbol",
        description:
          "Analyze a symbol's semantics in depth: callers, callees, complexity, dependencies, and behavior patterns. Use only after the symbol's definition is already located via search_graph — explain_symbol does NOT tell you where a symbol is defined.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Symbol name" },
            qualified_name: {
              type: "string",
              description: "Fully qualified name",
            },
          },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "find_tests",
        description: "Find test functions that cover a given symbol.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Symbol name to find tests for",
            },
          },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a file's full source code from the project. Use to confirm or inspect a definition that was already located by search_graph or grep.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative file path in the project",
            },
          },
          required: ["path"],
        },
      },
    },
  ];
}

export function makeBaselineTools(): AgentToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a file's full source code from the project. Use to confirm or inspect a definition that was already located by search_graph or grep.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative file path in the project",
            },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: "Search for a text pattern in project files.",
        parameters: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Text or regex pattern to search for",
            },
            include: {
              type: "string",
              description: "File pattern to include (e.g. *.ts)",
            },
          },
          required: ["pattern"],
        },
      },
    },
  ];
}

