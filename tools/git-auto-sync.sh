#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/home/ubuntu/.openclaw/workspace/openclaw-health-dashboard"
cd "$REPO_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

if [[ -n "$(git status --porcelain)" ]]; then
  git add -A
  if [[ -n "$(git diff --cached --name-only)" ]]; then
    TS="$(date "+%F %T %Z")"
    git commit -m "chore(auto-sync): dashboard update at ${TS}" >/dev/null 2>&1 || true
    git push origin main >/dev/null 2>&1 || true
  fi
fi
