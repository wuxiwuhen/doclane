#!/bin/sh
# scripts/git-push.sh — 推送 main 到 GitHub（带代理，端口可用 PROXY_PORT 覆盖）
# 用法: sh scripts/git-push.sh        # 推送并触发 Vercel 自动部署
#       PROXY_PORT=7890 sh scripts/git-push.sh   # 代理端口不同时覆盖
set -e
cd "$(dirname "$0")/.."
PROXY_PORT="${PROXY_PORT:-7897}"
git -c "http.https://github.com.proxy=http://127.0.0.1:${PROXY_PORT}" \
    push origin main "$@"
