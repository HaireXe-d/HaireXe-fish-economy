#!/usr/bin/env bash
# 一键安装（Linux / macOS）
#
# 用法：在仓库目录里执行
#   bash scripts/install.sh            # 自动挑 profile
#   bash scripts/install.sh web        # 或者指定 profile
#
# 装完提示你重启。配置不用手改：插件自带默认值（只作用于 whale 目录）。

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile="${1:-}"

echo
echo "== 养鱼经济学 · 安装 =="
echo "插件目录：$here"

if [ ! -f "$here/package.json" ]; then
  echo "这里不是插件目录（找不到 package.json）：$here" >&2
  exit 1
fi

profiles_dir="$HOME/.dsh/profiles"
existing=$(ls -1 "$profiles_dir" 2>/dev/null || true)

if [ -z "$profile" ]; then
  if echo "$existing" | grep -qx desktop; then
    profile=desktop
  elif echo "$existing" | grep -qx web; then
    profile=web
  elif [ "$(echo "$existing" | grep -c .)" = "1" ]; then
    profile=$(echo "$existing" | head -n 1)
  else
    echo "无法确定要装进哪个 profile。可用的有："
    echo "$existing" | sed 's/^/  - /'
    echo "用 bash scripts/install.sh <名字> 再跑一次。"
    exit 1
  fi
fi

echo "目标 profile：$profile（现有：$(echo "$existing" | tr '\n' ' ')）"

if ! command -v dsh >/dev/null 2>&1; then
  echo
  echo "找不到 dsh 命令。用图形界面装也一样："
  echo "  DSH → 设置 → 插件 → 从本地安装，选这个文件夹"
  exit 1
fi

echo "正在安装……"
dsh plugin --profile "$profile" add "$here"

echo
echo "装好了，重启一次 DSH 就生效。"
echo
echo "默认已经配好：工具闸门开、入口裁剪开、自动压缩开，只作用于路径带 whale 的会话。"
echo "之后想改：设置 → 养鱼经济学，卡片上两个开关，点一下立刻生效，不用重启。"
echo
echo "想看账本：~/.dsh/fish-economy/summary.json"
