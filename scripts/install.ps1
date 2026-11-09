# 一键安装（Windows PowerShell）
#
# 用法：在这个仓库目录里右键 → 在终端中打开，然后执行：
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Profile web
#
# 它只做一件事：把当前目录这个插件装进指定 profile（默认 desktop，即桌面版）。
# 装完会告诉你去改哪一行配置。不会碰你的养鱼插件，也不会改任何现有插件的代码。

param([string]$Profile = 'desktop')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot

Write-Host ''
Write-Host '== 养鱼电费 · 安装 ==' -ForegroundColor Cyan
Write-Host "插件目录：$here"
Write-Host "目标 profile：$Profile"

if (-not (Test-Path (Join-Path $here 'package.json'))) {
  throw "这里不是插件目录（找不到 package.json）：$here"
}

$profilesDir = Join-Path $env:USERPROFILE '.dsh\profiles'
if (Test-Path $profilesDir) {
  $existing = (Get-ChildItem $profilesDir -Directory | Select-Object -ExpandProperty Name) -join ', '
  Write-Host "机器上已有的 profile：$existing"
  if (-not (Test-Path (Join-Path $profilesDir $Profile))) {
    Write-Host "提示：没有 $Profile 这个 profile，可能名字不对（用上面的列表挑一个，加 -Profile 再跑）。" -ForegroundColor Yellow
  }
}

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if ($null -eq $dsh) {
  Write-Host ''
  Write-Host '找不到 dsh 命令。两种办法：' -ForegroundColor Yellow
  Write-Host '  1) 用 DSH 桌面版：设置 → 插件 → 从本地安装，选这个文件夹（不用猜 profile）'
  Write-Host '  2) 或者把下面这行里的 dsh 换成完整路径再跑一次：'
  Write-Host "     dsh plugin --profile $Profile add `"$here`""
  exit 1
}

Write-Host '正在安装……'
& dsh plugin --profile $Profile add $here
if ($LASTEXITCODE -ne 0) {
  throw "安装失败（退出码 $LASTEXITCODE）。把上面的报错贴到 GitHub issue 里。"
}

$patchFile = Join-Path $profilesDir "$Profile\cordis.patch.yml"

Write-Host ''
Write-Host '装好了。最后一步：告诉它你在养鱼。' -ForegroundColor Green
Write-Host ''
Write-Host "打开这个文件：$patchFile"
Write-Host '在末尾加上（QQ 鱼 / B 站鱼都适用）：'
Write-Host ''
Write-Host '  - id: fish-economy'
Write-Host '    config:'
Write-Host '      fish:'
Write-Host '        enabled: true'
Write-Host '        preset: work'
Write-Host ''
Write-Host '保存后重启 DSH。想更省，再把 extras\compaction-aggressive.yml 也加上。'
Write-Host ''
