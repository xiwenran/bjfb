#!/bin/sh

set -eu

git rev-parse --is-inside-work-tree >/dev/null 2>&1

BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH_NAME" = "HEAD" ]; then
  echo "当前不在分支上，无法自动同步。"
  exit 1
fi

COMMIT_MESSAGE="${1:-chore: sync local changes $(date +%Y-%m-%d-%H%M%S)}"

git add .

if git diff --cached --quiet; then
  echo "没有检测到可提交的改动。"
  exit 0
fi

git commit -m "$COMMIT_MESSAGE"
git push origin "$BRANCH_NAME"

echo "已同步到 origin/$BRANCH_NAME"
