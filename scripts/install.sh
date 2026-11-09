#!/usr/bin/env bash
# 一键安装（Linux / macOS）
#
# 用法：在仓库目录里执行
#   bash scripts/install.sh            # 默认装进 desktop profile
#   bash scripts/install.sh web        # 或者指定 profile 名
#
# 它只做一件事：把当前目录这个插件装进指定 profile。

set -euo pipefail

PROFILE="${1:-desktop}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo
echo "== 养鱼电费 · 安装 =="
echo "插件目录：$here"
echo "目标 profile：$PROFILE"

if [ ! -f "$here/package.json" ]; then
  echo "这里不是插件目录（找不到 package.json）：$here" >&2
  exit 1
fi

if [ -d "$HOME/.dsh/profiles" ]; then
  echo "机器上已有的 profile：$(ls -1 "$HOME/.dsh/profiles" | tr '\n' ' ')"
fi

if ! command -v dsh >/dev/null 2>&1; then
  echo
  echo "找不到 dsh 命令。两种办法："
  echo "  1) 用 DSH 桌面版：设置 → 插件 → 从本地安装，选这个文件夹（不用猜 profile）"
  echo "  2) 或者把下面这行里的 dsh 换成完整路径再跑一次："
  echo "     dsh plugin --profile $PROFILE add \"$here\""
  exit 1
fi

echo "正在安装……"
dsh plugin --profile "$PROFILE" add "$here"

echo
echo "装好了。最后一步：告诉它你在养鱼。"
echo
echo "打开 ~/.dsh/profiles/$PROFILE/cordis.patch.yml，在末尾加上："
echo
echo "  - id: fish-economy"
echo "    config:"
echo "      fish:"
echo "        enabled: true"
echo "        preset: work"
echo
echo "保存后重启 DSH。想更省，再把 extras/compaction-aggressive.yml 也加上。"
echo
