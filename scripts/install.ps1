# 一键安装（Windows PowerShell）
#
# 用法：在这个仓库目录里右键 → 在终端中打开，然后执行：
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#
# 它只做一件事：把当前目录这个插件装进 web profile。
# 装完会告诉你去改哪一行配置。不会碰你的养鱼插件，也不会改任何现有插件的代码。

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot

Write-Host ''
Write-Host '== 养鱼电费 · 安装 ==' -ForegroundColor Cyan
Write-Host "插件目录：$here"

if (-not (Test-Path (Join-Path $here 'package.json'))) {
  throw "这里不是插件目录（找不到 package.json）：$here"
}

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if ($null -eq $dsh) {
  Write-Host ''
  Write-Host '找不到 dsh 命令。两种办法：' -ForegroundColor Yellow
  Write-Host '  1) 用 DSH 桌面版：设置 → 插件 → 从本地安装，选这个文件夹'
  Write-Host '  2) 或者把下面这行里的 dsh 换成完整路径再跑一次：'
  Write-Host "     dsh plugin --profile web add `"$here`""
  exit 1
}

Write-Host '正在安装……'
& dsh plugin --profile web add $here
if ($LASTEXITCODE -ne 0) {
  throw "安装失败（退出码 $LASTEXITCODE）。把上面的报错贴到 GitHub issue 里。"
}

Write-Host ''
Write-Host '装好了。最后一步：告诉它你在养鱼。' -ForegroundColor Green
Write-Host ''
Write-Host '打开这个文件：'
Write-Host '  $env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml'
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
