# LYNX + Cursor — Integration Guide

## Prerequisites

- Node.js 20+
- Cursor installed (`~/.cursor/` or `~/Library/Application Support/Cursor/User/` exists)
- LYNX repo cloned and built: `npm run build`

## Installation

```bash
# 1. Verify your setup
node dist/cli.js doctor

# 2. Install (writes .mcp.json config)
node dist/cli.js install

# 3. Check what was written (dry-run)
node dist/cli.js install --dry-run
```

`lynx install` writes to `~/.cursor/.mcp.json`:

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

Cursor uses the same JSON format as Claude Code (`mcpServers` key, same
command/args structure). If Cursor isn't detected, nothing is written to
`~/.cursor/`.

Note: Cursor does not support hooks, so no `PreToolUse` hooks are written.
The agent instruction block (proportional LYNX discovery guidance) is injected into
`CLAUDE.md` or `AGENTS.md` at the project level via `lynx init`.

## Project Initialization

```bash
# In your project repo:
node dist/cli.js init          # writes CLAUDE.md / AGENTS.md with stats
node dist/cli.js init --dry-run  # preview only
```

This injects a managed block into project-level instruction files with real
project statistics. Cursor respects `CLAUDE.md` and `AGENTS.md` for custom
agent instructions.

## Health Check

```bash
node dist/cli.js doctor
```

10 checks: binary, database, projects, index freshness, locks, MCP runtime,
MCP configs, agent hooks (N/A for Cursor — no hooks support), runtime config,
license.

The MCP configs check verifies Cursor's `.mcp.json` has the `lynx` entry.

## Indexing

```bash
# Fast mode (best for frequent re-indexes)
node dist/cli.js index /path/to/project --mode fast

# Moderate mode (default)
node dist/cli.js index /path/to/project --mode moderate

# Full with LLM enrichment
node dist/cli.js index /path/to/project --mode full --llm
```

Or via the `index_repository` MCP tool from within Cursor:

```
index_repository({ repo_path: "/path/to/project", mode: "fast" })
```

Verify after indexing:

```
index_status({ project: "my-project" })
```

Freshness states:
- `ready` — index is up to date
- `stale` — index is older than `stale_threshold_hours` (default 24h)
- `updating` — index is in progress (lock held)
- `failed` — previous index failed, re-run to recover

## Automatic Indexing

Configure in `~/.lynx/config.json`:

```json
{
  "auto_index": true,
  "auto_index_limit": 50000,
  "auto_watch": true,
  "stale_threshold_hours": 24,
  "lock_ttl_minutes": 5
}
```

- `auto_index: true` — MCP server indexes on startup if project is unindexed
- `auto_watch: true` — file watcher re-indexes on save
- `stale_threshold_hours: 24` — index older than this triggers stale warning
- `lock_ttl_minutes: 5` — stale lock recovery window

## Deterministic Mode

LYNX is deterministic by default. All graph queries return deterministic
results without any AI dependency. LLM features require explicit opt-in:

- `search_graph`: set `enable_llm: false` for pure BM25 ranking.
- `detect_changes` / `assess_impact`: set `enable_llm: false`.
- `index_repository`: omit `llm_enrichment`.

Cursor's built-in AI (GPT-4/Claude) is separate from LYNX's optional LLM —
LYNX's tools provide the code intelligence; Cursor's AI consumes the results.

## DeepSeek (Optional)

If you want LYNX to use LLM for reranking, summarization, or enrichment:

```bash
export LYNX_DEEPSEEK_KEY="sk-..."
```

Without this key, all LYNX features work deterministically via heuristic
rules (test detection, entry-point classification, hotspot analysis).

## First Useful Queries

All queries below use `project: "my-project"` — replace with your project name.

1. **Find code by concept:**
   ```
   search_graph({ project: "my-project", query: "payment processing" })
   ```

2. **Trace complete call chains:**
   ```
   trace_path({ project: "my-project", function_name: "processPayment", direction: "both", depth: 3, risk_labels: true })
   ```

3. **Discover tests:**
   ```
   find_tests({ project: "my-project", qualified_name: "payments.processPayment" })
   ```

4. **Identify risky code:**
   ```
   analyze_hotspots({ project: "my-project", limit: 10, include_god_components: true })
   ```

5. **Auto-review with graph context:**
   ```
   smart_review({ project: "my-project", file: "src/payments/processor.ts" })
   ```

6. **Deep symbol explanation:**
   ```
   explain_symbol({ project: "my-project", qualified_name: "payments.processPayment" })
   ```

7. **Detect changes since main:**
   ```
   detect_changes({ project: "my-project", base_branch: "main", scope: "symbols", depth: 2 })
   ```

8. **Assess change impact:**
   ```
   assess_impact({ project: "my-project", max_findings: 100 })
   ```

9. **Batch-read multiple symbols:**
   ```
   batch_get_code({ project: "my-project", qualified_names: ["auth.login", "auth.logout", "auth.refresh"] })
   ```

## Example Workflow: Refactoring

```
# 1. For a broad refactor, assemble coordinated context
pack_context({ task: "Refactor auth module to use JWT", project: "my-project" })

# 2. Locate the relevant auth symbols
search_graph({ project: "my-project", query: "auth login register token" })

# 3. Use focused follow-ups only for material uncertainty
find_tests({ project: "my-project", qualified_name: "auth.handleLogin" })        # when coverage matters
trace_path({ project: "my-project", function_name: "auth.handleLogin", direction: "both" })  # when call flow matters
explain_symbol({ project: "my-project", qualified_name: "auth.handleLogin" })     # when behavior is still unclear

# 4. Inspect hotspots only when coupling or concentration may affect the design
analyze_hotspots({ project: "my-project", limit: 20 })

# 5. After refactoring, validate the actual changed scope
detect_changes({ project: "my-project", scope: "symbols" })
assess_impact({ project: "my-project", max_findings: 100 })
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| MCP tools not showing in Cursor | Restart Cursor after `lynx install`. Check `~/.cursor/.mcp.json`. |
| `search_graph` returns empty | Run `index_status` — project likely unindexed. Run `index_repository`. |
| `index_status` → `stale` | Re-index: `index_repository({ mode: "fast" })`. |
| `index_status` → `failed` | Re-run `index_repository`. Check `project_status_error` for the cause. |
| `index_status` → `updating` (stuck) | Check `lock_info` for orphaned PID. Use `force_lock: true` on next index. |
| "Project locked" error | Wait for current index to finish (~5s fast mode). If hung: `force_lock: true`. |
| `lynx doctor` shows config missing | Run `lynx install` again. Verify Cursor was detected. |
| MCP server won't start | Run `node dist/cli.js serve` manually to see startup errors. |

## Manual MCP Config (if install fails)

Create or edit `~/.cursor/.mcp.json`:

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

Restart Cursor after creating the file.

## Removal

```bash
node dist/cli.js uninstall              # remove MCP entries, blocks
node dist/cli.js uninstall --dry-run     # preview changes
```

Removes the `lynx` MCP entry from `~/.cursor/.mcp.json`, removes managed
blocks from instruction files. Backups are saved as `.lynx-bak`.

## Verification Checklist

- [ ] `lynx doctor` shows 11/11
- [ ] `~/.cursor/.mcp.json` has `lynx` entry
- [ ] `search_graph` returns results for your project
- [ ] `index_status` shows `freshness: "ready"`
- [ ] `detect_changes` and `assess_impact` work after a code edit
- [ ] `lynx uninstall --dry-run` shows clean removal
