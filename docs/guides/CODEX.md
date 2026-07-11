# LYNX + Codex CLI — Integration Guide

## Prerequisites

- Node.js 20+
- Codex CLI installed (`~/.codex/` exists)
- LYNX repo cloned and built: `npm run build`

## Installation

```bash
# 1. Verify your setup
node dist/cli.js doctor

# 2. Install (writes TOML MCP config, AGENTS.md block)
node dist/cli.js install

# 3. Check what was written (dry-run)
node dist/cli.js install --dry-run
```

`lynx install` writes to `~/.codex/config.toml`:

```toml
[mcp_servers.lynx]
command = "node"
args = ["/absolute/path/to/LYNX/dist/cli.js", "serve"]
```

It also injects a `<!-- lynx:start -->...<!-- lynx:end -->` block into
`~/.codex/AGENTS.md`. If Codex isn't detected, nothing is written to
`~/.codex/`.

Codex uses TOML format (not JSON) for MCP config. The `mcp_servers` key is the
top-level section. If a `lynx` entry already exists under `[mcp_servers]`,
it is refreshed (preserving any extra keys you added).

## Project Initialization

```bash
# In your project repo:
node dist/cli.js init          # writes AGENTS.md with project stats
node dist/cli.js init --dry-run  # preview only
```

The injected block includes real project stats: node count, edges, languages,
top hotspots. Codex will see this as high-priority instructions.

## Health Check

```bash
node dist/cli.js doctor
```

10 checks: binary, database, projects, index freshness, locks, MCP runtime,
MCP configs, agent hooks, runtime config, license.

Pay attention to the "MCP configs" check — it verifies the TOML entry for
Codex is present and correctly formatted.

## Indexing

```bash
# Fast mode (best for re-indexes and watcher)
node dist/cli.js index /path/to/project --mode fast

# Moderate mode (default, good balance)
node dist/cli.js index /path/to/project --mode moderate

# Full mode (all analysis + optional LLM enrichment)
node dist/cli.js index /path/to/project --mode full --llm
```

Or via MCP tool `index_repository` (works from within Codex if it supports
MCP tool calls):

```
index_repository({ repo_path: "/path/to/project", mode: "fast" })
```

After indexing, verify:

```
index_status({ project: "my-project" })
```

Freshness states: `ready` (healthy), `stale` (needs re-index), `updating`
(in progress), `failed` (error — re-run to recover).

## Automatic Indexing

Edit `~/.lynx/config.json`:

```json
{
  "auto_index": true,
  "auto_index_limit": 50000,
  "auto_watch": true,
  "stale_threshold_hours": 24,
  "lock_ttl_minutes": 5
}
```

The MCP server auto-indexes on startup when `auto_index: true`. The watcher
re-indexes changed files on save when `auto_watch: true`. Stale index (24h+)
triggers a warning.

## Deterministic Mode

All graph queries return deterministic results. LLM features require opt-in:

- `search_graph`: omit `enable_llm` or set to `false` for pure BM25 ranking.
- `index_repository`: omit `llm_enrichment` for no-LLM indexing.
- `detect_changes`: set `enable_llm: false` to skip AI risk classification.

The heuristic LLM (always active) handles reranking, test detection, and
entry-point classification deterministically — no API key needed.

## DeepSeek (Optional)

```bash
export LYNX_DEEPSEEK_KEY="sk-..."
```

With this key, LLM reranking in `search_graph` uses DeepSeek V4 Flash. Without
it, all features fall back to deterministic heuristics.

## First Useful Queries

1. **Search the graph:**
   ```
   search_graph({ project: "my-project", query: "authentication" })
   ```

2. **Trace call paths:**
   ```
   trace_path({ project: "my-project", function_name: "handleLogin", direction: "both", depth: 3 })
   ```

3. **Find tests for a function:**
   ```
   find_tests({ project: "my-project", qualified_name: "auth.handleLogin" })
   ```

4. **Analyze hotspots:**
   ```
   analyze_hotspots({ project: "my-project", limit: 10 })
   ```

5. **Smart review:**
   ```
   smart_review({ project: "my-project", file: "src/auth/login.ts" })
   ```

6. **Explain a symbol:**
   ```
   explain_symbol({ project: "my-project", qualified_name: "auth.handleLogin" })
   ```

7. **Detect changes:**
   ```
   detect_changes({ project: "my-project", scope: "symbols", depth: 2 })
   ```

8. **Assess impact:**
   ```
   assess_impact({ project: "my-project", max_findings: 50 })
   ```

## Example Workflow: Code Review

```
# 1. See what changed since main
detect_changes({ project: "my-project", base_branch: "main", scope: "symbols" })

# 2. Assess the blast radius
assess_impact({ project: "my-project", max_findings: 100 })

# 3. Review riskiest changed files
smart_review({ project: "my-project", file: "src/auth/login.ts" })

# 4. Check if changed functions have tests
find_tests({ project: "my-project", qualified_name: "auth.handleLogin" })

# 5. Trace who calls the changed function
trace_path({ project: "my-project", function_name: "handleLogin", direction: "inbound" })
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `search_graph` returns empty | Run `index_status` — project may not be indexed. |
| `index_status` shows `stale` | Re-index: `index_repository({ mode: "fast" })`. |
| `index_status` shows `failed` | Re-run `index_repository` to recover. Check `status_error`. |
| `index_status` shows `updating` (stuck) | Check `lock_info` for orphaned lock. Use `force_lock: true`. |
| "Project locked" error | Wait (~5s for fast mode). If stuck: `force_lock: true` on next index. |
| Codex doesn't see LYNX tools | Run `lynx doctor`, check MCP configs. Restart Codex. |
| TOML section not found | Run `lynx install` to write it. Verify `~/.codex/config.toml` has `[mcp_servers.lynx]`. |

## Manual TOML Config (if install fails)

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.lynx]
command = "node"
args = ["/absolute/path/to/LYNX/dist/cli.js", "serve"]
```

Restart Codex after editing.

## Removal

```bash
node dist/cli.js uninstall              # remove MCP entries, blocks
node dist/cli.js uninstall --dry-run     # preview changes
```

Removes the `[mcp_servers.lynx]` section from `config.toml`, removes managed
blocks from `AGENTS.md`. Original configs are backed up as `.lynx-bak`.

## Verification Checklist

- [ ] `lynx doctor` shows 10/10
- [ ] `~/.codex/config.toml` has `[mcp_servers.lynx]` section
- [ ] `search_graph` returns results for your project
- [ ] `index_status` shows `freshness: "ready"`
- [ ] `detect_changes` works after a code edit
- [ ] `lynx uninstall --dry-run` shows what would be removed
