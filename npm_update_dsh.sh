#!/usr/bin/env bash
# 升级 dsh 与全部插件到最新，并重放兼容补丁。
#
# 本部署运行 npm `next` 通道的 dsh：@linxin666/dsh-web-all 0.4.7+ 的 peer 要求
# @deepseek-ai/dsh >=0.2.1-rc.2（npm latest 标签还是 0.2.0-rc.2 时装不上最新插件）。
# 回退 DSH_TAG=latest 前先确认各插件 peerDependencies 兼容。
#
# 注意：
# - GitHub 钉提交的插件（vision-toolkit / dsh-toolkit / dsh-at-file / anchored-standard）
#   不会被 update 移动，需要手动改 ~/.dsh/profiles/web/package.json 的钉值。
# - @deepseek-ai/dsh-toolkit 的 peer 上限停留在 <0.2.0，每次 dsh 升级后需要重新
#   授权（脚本下方已自动执行，无需手动）。
# - @anionex/dsh-vision-toolkit（GitHub 钉提交）若上游还没发适配新 dsh 的版本，
#   升级后会被整包 skip；临时用豁免放行：
#   dsh plugin --profile web allow-version @anionex/dsh-vision-toolkit@<钉住版本> \
#     --dsh-version <新版本> --accept-risk（2026-10-27 对 0.1.48/rc.4 已豁免）。
# - profile 用 pnpm nodeLinker:hoisted，@linxin666/dsh-agents 的传递依赖
#   @deepseek-ai/dsh-session-projection 会被提升到 profile 顶层，遮蔽 dsh 自带
#   副本；pnpm 11 的 minimumReleaseAge 还会把它停在旧 rc → dsh web 以
#   "1 required plugin did not activate" 拒绝启动（2026-10-27 rc.4 升级即此）。
#   脚本下方以直接依赖精确钉到当前 dsh 版本来自动对齐。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_TAG="${DSH_TAG:-next}"

echo "[update] 安装 @deepseek-ai/dsh@${DSH_TAG} …"
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs "@deepseek-ai/dsh@${DSH_TAG}"

echo "[update] 同步并升级 profile 插件 …"
cd ~/.dsh/profiles/web
dsh plugin --profile web install
dsh plugin --profile web update

DSH_VER="$(dsh --version 2>/dev/null | grep -E '^[0-9a-z]' | tail -1)"

echo "[update] 对齐 profile 内被提升的 @deepseek-ai/dsh-session-projection 到 ${DSH_VER} …"
pnpm add "@deepseek-ai/dsh-session-projection@${DSH_VER}"

echo "[update] 重新授权 dsh-toolkit 运行于 ${DSH_VER} …"
dsh plugin --profile web allow-version @deepseek-ai/dsh-toolkit@0.0.1 \
  --dsh-version "${DSH_VER}" --accept-risk

echo "[update] 重放兼容补丁 …"
node "${SCRIPT_DIR}/patches/apply-plugin-compat.mjs"
node "${SCRIPT_DIR}/patches/apply-dsh-migration-compat.mjs"

echo "[update] 完成。重启服务：cd ${SCRIPT_DIR} && ./dsh-service.sh restart"
