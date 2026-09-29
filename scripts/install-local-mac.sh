#!/usr/bin/env bash
# 一键本机安装：打包 → 退出旧版 → 旧版进废纸篓 → 装新版 → 启动 → 核对版本号与服务在线
# 用法：npm run install:mac-local
# 任一步失败立即停止并说明原因；旧版只进废纸篓，不做永久删除。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="知发"
TARGET="/Applications/${APP_NAME}.app"
BUILT="$ROOT/dist/mac-arm64/${APP_NAME}.app"
STAGING="/Applications/${APP_NAME}.app.installing"
HEALTH_URL="http://127.0.0.1:3210/"

step() { printf '\n==> %s\n' "$1"; }
fail() { printf '\n✗ %s\n' "$1" >&2; exit 1; }

cd "$ROOT"

step "1/7 检查工作区是否干净"
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  fail "有未提交的改动。打包会把它们一起装进 App，请先提交或暂存后再装。"
fi
EXPECTED="$(git rev-parse --short HEAD)"
echo "将安装提交 ${EXPECTED}"

step "2/7 打包"
npm run dist:mac
[ -d "$BUILT" ] || fail "打包产物不存在：$BUILT"
BUILT_COMMIT="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['commit'])" "$BUILT/Contents/Resources/app/src/build-info.json")"
[ "$BUILT_COMMIT" = "$EXPECTED" ] || fail "打包产物版本号 ${BUILT_COMMIT} 与当前提交 ${EXPECTED} 不一致"

step "3/7 复制新版到临时位置"
if [ -e "$STAGING" ]; then
  /usr/bin/trash "$STAGING"
fi
ditto "$BUILT" "$STAGING"
[ -f "$STAGING/Contents/Resources/app/src/build-info.json" ] || fail "新版复制不完整：$STAGING"

step "4/7 退出正在运行的${APP_NAME}"
if pgrep -f "${TARGET}/Contents/MacOS/${APP_NAME}" >/dev/null 2>&1; then
  osascript -e "quit app \"${APP_NAME}\"" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    pgrep -f "${TARGET}/Contents/MacOS/${APP_NAME}" >/dev/null 2>&1 || break
    sleep 1
  done
  if pgrep -f "${TARGET}/Contents/MacOS/${APP_NAME}" >/dev/null 2>&1; then
    fail "30 秒内${APP_NAME}没有正常退出（可能正在发布）。请手动退出后重跑；新版已放在 $STAGING"
  fi
fi
echo "已退出"

step "5/7 旧版进废纸篓，换上新版"
if [ -e "$TARGET" ]; then
  /usr/bin/trash "$TARGET"
fi
mv "$STAGING" "$TARGET"

step "6/7 启动并核对版本号"
INSTALLED="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['commit'])" "$TARGET/Contents/Resources/app/src/build-info.json")"
[ "$INSTALLED" = "$EXPECTED" ] || fail "已安装版本号 ${INSTALLED} 与提交 ${EXPECTED} 不一致"
open -a "$TARGET"

step "7/7 等待服务上线"
for _ in $(seq 1 60); do
  if [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$HEALTH_URL" || true)" = "200" ]; then
    printf '\n✓ 安装完成：%s 已上线，版本 %s（旧版在废纸篓，需要可放回）\n' "$APP_NAME" "$INSTALLED"
    exit 0
  fi
  sleep 1
done
fail "新版已安装并启动，但 60 秒内服务 ${HEALTH_URL} 未响应，请查看 ${APP_NAME} 是否报错"
