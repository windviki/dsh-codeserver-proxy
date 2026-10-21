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
# - @deepseek-ai/dsh-toolkit 的 peer 上限停留在 <0.2.0，每次 dsh 升级后如日志报
#   "incompatible ... dsh-toolkit"，需要重新授权：
#   dsh plugin --profile web allow-version @deepseek-ai/dsh-toolkit@0.0.1 \
#     --dsh-version <新版本> --accept-risk
# - @linxin666/dsh-client-ui-skin-center 以直接依赖精确钉在 0.4.5：0.4.7 引入了
#   未发布 API（installSettingsSection），等上游修复后删除该钉（package.json 里
#   的 "0.4.5" 直接依赖）再 update。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_TAG="${DSH_TAG:-next}"

echo "[update] 安装 @deepseek-ai/dsh@${DSH_TAG} …"
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs "@deepseek-ai/dsh@${DSH_TAG}"

echo "[update] 同步并升级 profile 插件 …"
cd ~/.dsh/profiles/web
dsh plugin --profile web install
dsh plugin --profile web update

echo "[update] 重放兼容补丁 …"
node "${SCRIPT_DIR}/patches/apply-plugin-compat.mjs"
node "${SCRIPT_DIR}/patches/apply-dsh-migration-compat.mjs"

echo "[update] 完成。重启服务：cd ${SCRIPT_DIR} && ./dsh-service.sh restart"
