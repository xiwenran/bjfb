#!/bin/zsh

set -eu

cd "$(dirname "$0")"

echo "开始本地打包 macOS 安装包..."

if [ ! -d node_modules ]; then
  echo "未找到 node_modules，请先执行 npm install。"
  read -r "?按回车关闭窗口..."
  exit 1
fi

npm run dist:mac

echo ""
echo "macOS 安装包已生成到 dist/ 目录。"
read -r "?按回车关闭窗口..."
