#!/bin/sh

set -eu

git rev-parse --is-inside-work-tree >/dev/null 2>&1

if ! command -v gh >/dev/null 2>&1; then
  echo "未找到 gh，请先安装 GitHub CLI。"
  exit 1
fi

ARTIFACT_PATH="${1:-dist/知发 macOS.zip}"

if [ ! -f "$ARTIFACT_PATH" ]; then
  echo "未找到本地 mac 安装包：$ARTIFACT_PATH"
  echo "请先执行 npm run dist:mac"
  exit 1
fi

REMOTE_URL="$(git remote get-url origin)"
case "$REMOTE_URL" in
  git@github.com:*)
    REPO_SLUG="${REMOTE_URL#git@github.com:}"
    ;;
  https://github.com/*)
    REPO_SLUG="${REMOTE_URL#https://github.com/}"
    ;;
  *)
    echo "无法从 origin 识别 GitHub 仓库地址：$REMOTE_URL"
    exit 1
    ;;
esac
REPO_SLUG="${REPO_SLUG%.git}"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
CURRENT_SHA="$(git rev-parse --short HEAD)"
DEFAULT_TAG="local-mac-${CURRENT_BRANCH}-$(date +%Y%m%d-%H%M%S)"
RELEASE_TAG="${2:-$DEFAULT_TAG}"
RELEASE_TITLE="${3:-知发 macOS 本地构建 ${CURRENT_BRANCH} ${CURRENT_SHA}}"
RELEASE_NOTES="${4:-知发本地 Mac 打包上传。分支：${CURRENT_BRANCH}，提交：${CURRENT_SHA}。}"

if gh release view "$RELEASE_TAG" --repo "$REPO_SLUG" >/dev/null 2>&1; then
  gh release upload "$RELEASE_TAG" "$ARTIFACT_PATH" --clobber --repo "$REPO_SLUG"
  echo "已更新 Release：$RELEASE_TAG"
else
  gh release create "$RELEASE_TAG" "$ARTIFACT_PATH" \
    --repo "$REPO_SLUG" \
    --target "$(git rev-parse HEAD)" \
    --title "$RELEASE_TITLE" \
    --notes "$RELEASE_NOTES"
  echo "已创建 Release：$RELEASE_TAG"
fi
