#!/usr/bin/env bash
# 一键安装 / 更新「术语向导」到 dsh 的 profile
#
# 用法：
#   ./install.sh                 # 装到 web profile
#   ./install.sh tui             # 装到别的 profile
#   DSH_BIN=/path/to/dsh ./install.sh   # dsh 不在 PATH 时指定可执行文件
#
# 做的事情与 dsh 面板里的「添加插件 → 安装」完全一致（底层都是 pnpm add）：
#   1. 把包写进 profile 的 dependencies
#   2. 把它加进 dsh.profile.bundles（于是 cordis.patch.yml 自动生效，启动不用 --patch）
#   3. 让 pnpm 建立 node_modules 链接
set -euo pipefail

PROFILE_NAME="${1:-web}"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_BIN="${DSH_BIN:-dsh}"

say() { printf '%s\n' "$*"; }

# 1) dsh 可执行文件
if ! command -v "$DSH_BIN" >/dev/null 2>&1 && [ ! -x "$DSH_BIN" ]; then
  say "✗ 找不到 dsh：$DSH_BIN"
  say "  请把它加进 PATH，或用 DSH_BIN=/绝对路径/dsh ./install.sh"
  exit 1
fi

# 2) pnpm（插件管理器用 pnpm add，缺了安装必失败）
if ! command -v pnpm >/dev/null 2>&1; then
  say "✗ 找不到 pnpm —— 插件安装需要它。安装方式之一："
  say "    npm install -g pnpm --prefix \"\$HOME/.local/npm-global\""
  say "    export PATH=\"\$HOME/.local/npm-global/bin:\$PATH\""
  exit 1
fi
say "dsh    : $DSH_BIN"
say "pnpm   : $(pnpm --version)"
say "plugin : $PLUGIN_DIR"
say "profile: $PROFILE_NAME"

# 3) 安装 / 更新（幂等：已安装时 pnpm 会报 Already up to date）
"$DSH_BIN" plugin --profile "$PROFILE_NAME" add "$PLUGIN_DIR"

say ""
say "✓ 完成。重启 dsh 后生效："
say "    dsh web --no-open --port 3080"
say "  然后从日志里取带 token 的地址：tail -n 3 <你的日志>"
say ""
say "  验证插件已加载："
say "    curl -s -b <cookie> http://127.0.0.1:3080/learning-assistant/state"
say "    # 或直接看对话标题栏是否出现「术语 N」按钮"
say ""
say "卸载：  $DSH_BIN plugin --profile $PROFILE_NAME remove dsh-learning-assistant"
