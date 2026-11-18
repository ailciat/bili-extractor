#!/usr/bin/env bash
# 提炼 · macOS / Linux 启动脚本
# 用法：./start.sh

set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 没有检测到 Node.js，请先安装 18 以上版本：https://nodejs.org"
  exit 1
fi

# 首次运行会自动补齐依赖，之后每次只是秒级检查
node scripts/ensure-deps.js

echo ""
echo "正在启动，浏览器会自动打开界面。按 Ctrl+C 退出。"
echo ""
exec node server.js
