# 一键安装（Windows PowerShell）
#
# 用法：在这个仓库目录里右键 → 在终端中打开，然后执行：
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#
# 它会自己挑 profile（桌面版 desktop / 网页版 web），装完提示你重启。
# 配置不用手改：插件自带默认值（只作用于 whale 目录，装完即生效）。
# 不会碰你的养鱼插件，也不会改任何现有插件的代码。

param([string]$Profile = '')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot

Write-Host ''
Write-Host '== 养鱼经济学 · 安装 ==' -ForegroundColor Cyan
Write-Host "插件目录：$here"

if (-not (Test-Path (Join-Path $here 'package.json'))) {
  throw "这里不是插件目录（找不到 package.json）：$here"
}

$profilesDir = Join-Path $env:USERPROFILE '.dsh\profiles'
$existing = @()
if (Test-Path $profilesDir) {
  $existing = Get-ChildItem $profilesDir -Directory | Select-Object -ExpandProperty Name
}

if ($Profile -eq '') {
  if ($existing -contains 'desktop') { $Profile = 'desktop' }
  elseif ($existing -contains 'web') { $Profile = 'web' }
  elseif ($existing.Count -eq 1) { $Profile = $existing[0] }
  else {
    Write-Host '无法确定要装进哪个 profile。可用的有：' -ForegroundColor Yellow
    $existing | ForEach-Object { Write-Host "  - $_" }
    Write-Host '用 -Profile <名字> 再跑一次。'
    exit 1
  }
}

Write-Host "目标 profile：$Profile（机器上现有：$($existing -join ', ')）"

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if ($null -eq $dsh) {
  Write-Host ''
  Write-Host '找不到 dsh 命令。用图形界面装也一样：' -ForegroundColor Yellow
  Write-Host '  DSH → 设置 → 插件 → 从本地安装，选这个文件夹'
  exit 1
}

Write-Host '正在安装……'
& dsh plugin --profile $Profile add $here
if ($LASTEXITCODE -ne 0) {
  throw "安装失败（退出码 $LASTEXITCODE）。把上面的报错贴到 GitHub issue 里。"
}

Write-Host ''
Write-Host '装好了，重启一次 DSH 就生效。' -ForegroundColor Green
Write-Host ''
Write-Host '默认已经配好：工具闸门开、入口裁剪开、自动压缩开，只作用于路径带 whale 的会话。'
Write-Host '之后想改：设置 → 养鱼经济学，卡片上两个开关，点一下立刻生效，不用重启。'
Write-Host ''
Write-Host "想看账本：$env:USERPROFILE\.dsh\fish-economy\summary.json"
