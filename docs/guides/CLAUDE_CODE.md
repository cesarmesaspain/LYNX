# LYNX + Claude Code — Integration Guide

## Prerequisites

- Node.js 20+
- Claude Code installed (`claude` on PATH, `~/.claude/` exists)
- LYNX repo cloned and built: `npm run build`

## Installation

```bash
# 1. Verify your setup
node dist/cli.js doctor

# 2. Install (writes MCP config, SKILL.md)
node dist/cli.js install

# 3. Check what was written (dry-run)
node dist/cli.js install --dry-run
```

`lynx install` writes to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "lynx": {
      "command": "node",
      "args": ["/absolute/path/to/LYNX/dist/cli.js", "serve"]
    }
  }
}
```

It also writes a `SKILL.md` at the project root with managed blocks, and a
`PreToolUse` hook (non-blocking, 5s timeout) that augments grep/glob results
with graph matches. If Claude Code isn't detected, nothing is written to
`~/.claude/`.

## Project Initialization

```bash
# In your project repo:
node dist/cli.js init          # writes CLAUDE.md with project stats
node dist/cli.js init --dry-run  # preview only
```

This injects a `<!-- lynx:start -->...<!-- lynx:end -->` block into
`CLAUDE.md` with real project stats (node count, edges, languages, hotspots).

The block recommends proportional discovery: use pack_context for broad
multi-symbol tasks, focused graph tools for structural evidence, and direct
file tools when they are the more precise or efficient choice.

## Health Check

```bash
node dist/cli.js doctor
```

10 checks: binary, database, projects, index freshness, locks, MCP runtime,
MCP configs, agent hooks, runtime config, license. All must pass (10/10).

## Indexing

```bash
# Fast (default for watcher, skips heavy analysis)
node dist/cli.js index /path/to/project --mode fast

# Moderate (default for CLI)
node dist/cli.js index /path/to/project --mode moderate

# Full (includes LLM enrichment if --llm passed)
node dist/cli.js index /path/to/project --mode full --llm
```

Alternatively, use the MCP tool `index_repository` from within Claude Code:

```
index_repository({ repo_path: "/path/to/project", mode: "fast" })
```

After indexing, run `index_status` to verify:

```
index_status({ project: "my-project" })
```

Returns freshness (`ready`/`stale`/`updating`/`failed`), node/edge counts,
and lock info.

## Automatic Indexing

Set `auto_index: true` and `auto_watch: true` in `~/.lynx/config.json`:

```json
{
  "auto_index": true,
  "auto_index_limit": 50000,
  "auto_watch": true,
  "stale_threshold_hours": 24,
  "lock_ttl_minutes": 5
}
```

The MCP server auto-indexes on startup (skips if already indexed and fresh).
The file watcher re-indexes changed files on save. Stale index (24h+) triggers
a freshness warning and the handler recommends re-indexing.

## Deterministic Mode

LYNX is deterministic by default. All graph queries (`search_graph`,
`trace_path`, `query_graph`) return deterministic results sorted by BM25
relevance. LLM features require explicit opt-in:

- `search_graph`: pass `enable_llm: false` (default true, falls back to
  heuristic if no API key is set).
- `index_repository`: pass `--no-llm` in CLI, or omit `llm_enrichment` in MCP.
- `detect_changes` / `assess_impact`: pass `enable_llm: false` to skip AI risk
  classification.

## DeepSeek (Optional)

Set `LYNX_DEEPSEEK_KEY` to enable LLM reranking and enrichment:

```bash
export LYNX_DEEPSEEK_KEY="sk-..."
```

Without this key, all LLM features degrade gracefully to heuristic rules
(deterministic). The heuristic LLM is always active and handles reranking,
test detection, and entry-point classification at zero cost.

For local LLM (Qwen via MLX):

```bash
export LYNX_QWEN_URL="http://localhost:8011/v1"
export LYNX_QWEN_MODEL="mlx-community/Qwen3.6-35B-A3B-4bit"
```

## First Useful Queries

1. **Explore the code graph:**
   ```
   search_graph({ project: "my-project", query: "authentication handler" })
   ```

2. **Find all callers of a function:**
   ```
   trace_path({ project: "my-project", function_name: "handleLogin", direction: "inbound" })
   ```

3. **Find tests covering a function:**
   ```
   find_tests({ project: "my-project", qualified_name: "auth.handleLogin" })
   ```

4. **Find hotspots (riskiest functions):**
   ```
   analyze_hotspots({ project: "my-project", limit: 10 })
   ```

5. **Review a file with graph intelligence:**
   ```
   smart_review({ project: "my-project", file: "src/auth/login.ts" })
   ```

6. **Deep-dive on a symbol:**
   ```
   explain_symbol({ project: "my-project", qualified_name: "auth.handleLogin" })
   ```

7. **Detect changes and their impact:**
   ```
   detect_changes({ project: "my-project", scope: "symbols", depth: 2 })
   ```

## Example Workflow: Bug Fix

```
# 1. Understand the bug area
pack_context({ task: "Fix login timeout bug in auth module", project: "my-project" })

# 2. Find the handler
search_graph({ project: "my-project", query: "login handler", label: "Function" })

# 3. Check its callers (who depends on it)
trace_path({ project: "my-project", function_name: "handleLogin", direction: "inbound", depth: 2 })

# 4. Find its tests
find_tests({ project: "my-project", qualified_name: "auth.handleLogin" })

# 5. Read the code
get_code_snippet({ project: "my-project", qualified_name: "auth.handleLogin" })

# 6. Review for risks
smart_review({ project: "my-project", qualified_name: "auth.handleLogin" })

# 7. After fixing, check impact
detect_changes({ project: "my-project", scope: "symbols" })
assess_impact({ project: "my-project", max_findings: 50 })
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `search_graph` returns empty | Run `index_status` to check if project is indexed. If not: `index_repository`. |
| `index_status` shows `stale` | Re-index: `index_repository({ mode: "fast" })` or `lynx index --mode fast`. |
| `index_status` shows `failed` | Re-index to recover. Check `status_error` in response. |
| `index_status` shows `updating` (stuck) | Check `lock_info`. If orphaned (stale PID): `force_lock: true` on next index. |
| MCP server not responding | Run `lynx doctor`, check MCP runtime check. Verify server started. |
| `lynx install` skips an agent | Agent not detected. Run `lynx doctor` to see which agents were found. |
| "Project locked" error | Wait for indexing to complete (typically <5s for fast mode). If stuck: use `force_lock: true`. |

## Removal

```bash
node dist/cli.js uninstall              # remove MCP entries, hooks, SKILL.md
node dist/cli.js uninstall --dry-run     # preview changes
```

Removes the `lynx` MCP entry from all agent configs, removes managed blocks
from instruction files, and cleans up hooks. Original configs are restored
from `.lynx-bak` backups.

## Manual MCP Config (if install fails)

```json
{
  "mcpServers": {
    "lynx": {
      "command": "node",
      "args": ["/absolute/path/to/LYNX/dist/cli.js", "serve"]
    }
  }
}
```

Restart Claude Code after editing `.mcp.json`.

## Verification Checklist

- [ ] `lynx doctor` shows 11/11
- [ ] `search_graph` returns real results for your project
- [ ] `index_status` shows `freshness: "ready"`
- [ ] `detect_changes` works after a code edit
- [ ] `lynx uninstall --dry-run` shows what would be removed
