#!/usr/bin/env bash
# Regenerate code-only Graphify graph (AST, no LLM). Requires: pip install graphifyy
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
GRAPHIFY="${GRAPHIFY:-graphify}"
if ! command -v "$GRAPHIFY" >/dev/null 2>&1; then
  GRAPHIFY="${HOME}/.local/bin/graphify"
fi
"$GRAPHIFY" extract . --code-only --no-gitignore
"$GRAPHIFY" cluster-only . --no-label
