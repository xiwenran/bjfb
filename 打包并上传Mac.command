#!/bin/zsh

set -eu

cd "$(dirname "$0")"

echo "开始本地打包并上传 macOS 安装包..."

if ! command -v gh >/dev/null 2>&1; then
  echo "未找到 gh，请先安装 GitHub CLI。"
  read -r "?按回车关闭窗口..."
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh 尚未登录，请先执行 gh auth login。"
  read -r "?按回车关闭窗口..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "未找到 node_modules，请先执行 npm install。"
  read -r "?按回车关闭窗口..."
  exit 1
fi

npm run dist:mac
npm run release:mac-local

echo ""
echo "macOS 安装包已上传到 GitHub Release。"
read -r "?按回车关闭窗口..."
