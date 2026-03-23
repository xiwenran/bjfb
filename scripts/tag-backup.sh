#!/bin/sh

set -eu

TAG_NAME="backup-$(date +%Y%m%d-%H%M%S)"

git rev-parse --is-inside-work-tree >/dev/null 2>&1
git tag "$TAG_NAME"

echo "Created tag: $TAG_NAME"
echo "Push it with: git push origin --tags"
