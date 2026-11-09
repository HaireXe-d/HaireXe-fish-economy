#!/usr/bin/env bash
# 一键安装（Linux / macOS）
#
# 用法：在仓库目录里执行
#   bash scripts/install.sh
#
# 它只做一件事：把当前目录这个插件装进 web profile。

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo
echo "== 养鱼电费 · 安装 =="
echo "插件目录：$here"

if [ ! -f "$here/package.json" ]; then
  echo "这里不是插件目录（找不到 package.json）：$here" >&2
  exit 1
fi

if ! command -v dsh >/dev/null 2>&1; then
  echo
  echo "找不到 dsh 命令。两种办法："
  echo "  1) 用 DSH 桌面版：设置 → 插件 → 从本地安装，选这个文件夹"
  echo "  2) 或者把下面这行里的 dsh 换成完整路径再跑一次："
  echo "     dsh plugin --profile web add \"$here\""
  exit 1
fi

echo "正在安装……"
dsh plugin --profile web add "$here"

echo
echo "装好了。最后一步：告诉它你在养鱼。"
echo
echo "打开 ~/.dsh/profiles/web/cordis.patch.yml，在末尾加上："
echo
echo "  - id: fish-economy"
echo "    config:"
echo "      fish:"
echo "        enabled: true"
echo "        preset: work"
echo
echo "保存后重启 DSH。想更省，再把 extras/compaction-aggressive.yml 也加上。"
echo
