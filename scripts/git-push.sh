#!/bin/sh
# scripts/git-push.sh — 推送 main 到 GitHub（带代理 + gh 凭据桥接）
# 用法: sh scripts/git-push.sh        # 推送并触发 Vercel 自动部署
set -e
cd "$(dirname "$0")/.."
git -c http.https://github.com.proxy=http://127.0.0.1:7890 \
    -c credential.helper="$PWD/.gh/git-cred.sh" \
    push origin main "$@"
