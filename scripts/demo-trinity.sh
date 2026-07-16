#!/usr/bin/env bash
# demo-trinity.sh — Demonstrate LYNX's Trinity of Validation in 60 seconds.
#
# Usage:
#   bash scripts/demo-trinity.sh [repo-path] [project-name]
#   Default: indexes LYNX itself and modifies src/pipeline/orchestrator.ts

set -euo pipefail

REPO="${1:-.}"
PROJECT="${2:-LYNX}"
TARGET_FILE="src/pipeline/orchestrator.ts"

if [ ! -f "$REPO/$TARGET_FILE" ]; then
  TARGET_FILE="src/index.ts"  # fallback
fi

echo "╔══════════════════════════════════════════════════╗"
echo "║   LYNX — Trinity of Validation Demo             ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "Repo: $REPO  |  Project: $PROJECT  |  Target: $TARGET_FILE"
echo ""

# ── Step 1: Index ──────────────────────────────────────────
echo "→ Indexing repository (fast mode)..."
node dist/cli.js index "$REPO" --name "$PROJECT" --mode fast --incremental 2>&1 | tail -1
echo ""

# ── Step 2: Make a temporary change ─────────────────────────
echo "→ Making temporary change to $TARGET_FILE..."
BACKUP="$REPO/$TARGET_FILE.bak"
cp "$REPO/$TARGET_FILE" "$BACKUP"
echo "// LYNX demo comment $(date +%s)" >> "$REPO/$TARGET_FILE"
echo "  Change applied."
echo ""

# ── Step 3: Run assess_impact ───────────────────────────────
echo "→ Running assess_impact..."
RESULT=$(node scripts/run-assess.js --project "$PROJECT" --base-branch main --json 2>/dev/null || echo '{"error":"failed"}')
echo ""

# ── Step 4: Revert change ───────────────────────────────────
echo "→ Reverting temporary change..."
mv "$BACKUP" "$REPO/$TARGET_FILE"
echo "  Reverted."
echo ""

# ── Step 5: Display Trinity results ─────────────────────────
echo "╔══════════════════════════════════════════════════╗"
echo "║   Trinity of Validation Results                  ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

SUMMARY=$(node -e "console.log((${RESULT}).summary || 'N/A')" 2>/dev/null || echo "N/A")
echo "Summary: $SUMMARY"
echo ""

echo "┌─────────────────────────────────────────────────┐"
echo "│ Dimension               │ Result                │"
echo "├─────────────────────────────────────────────────┤"

# Blast Radius
BR=$(node -e "const r = (${RESULT}); console.log((r.direct_dependent_files || []).length)" 2>/dev/null || echo "?")
echo "│ 1. Blast Radius (CALLS) │ $BR dependent file(s)       │"

# Event Bridge
EB=$(node -e "const r = (${RESULT}); console.log((r.async_dependent_files || []).length)" 2>/dev/null || echo "?")
echo "│ 2. Event Bridge (EMITS) │ $EB dependent file(s)       │"

# Sibling Invariants
SI=$(node -e "const r = (${RESULT}); console.log((r.sibling_invariants_broken || []).length)" 2>/dev/null || echo "?")
echo "│ 3. Sibling Invariants   │ $SI violation(s)            │"

# Architecture Rules
AR=$(node -e "const r = (${RESULT}); console.log((r.architecture_rules_broken || []).length)" 2>/dev/null || echo "?")
echo "│ 4. Architecture Rules   │ $AR violation(s)            │"

echo "└─────────────────────────────────────────────────┘"
echo ""

FINDINGS=$(node -e "const r = (${RESULT}); const f = r.findings || []; f.slice(0,5).forEach(x => console.log('  [' + x.overall_confidence + '] ' + (x.category || '') + ': ' + (x.detail || '').slice(0,100)))" 2>/dev/null || echo "  N/A")
echo "Top findings:"
echo "$FINDINGS"
echo ""
echo "═══ Demo complete ═══"
