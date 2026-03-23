#!/bin/bash
cd "$(dirname "$0")"

# 如果端口被占用，先释放
lsof -ti:3210 | xargs kill -9 2>/dev/null

echo "🚀 正在启动蚁小二发布工具..."

# 2秒后自动打开浏览器
(sleep 2 && open "http://localhost:3210") &

node src/server.js
