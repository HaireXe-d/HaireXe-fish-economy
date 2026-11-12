@echo off
chcp 65001 >nul 2>&1
title 养鱼经济学 · 一键安装
cls

echo.
echo   ============================================
echo      养鱼经济学 · 一键安装
echo   ============================================
echo.
echo   它会：
echo.
echo     1. 把插件装到 DSH 里（几秒钟）
echo     2. 不用联网、不用装别的
echo.
echo   需要先装好 DeepSeek Harness 并打开过一次。
echo.
pause

echo.
echo   找 Node.js...

set "NODE_EXE=node.exe"
where node >nul 2>&1
if errorlevel 1 (
  for /d %%D in ("%USERPROFILE%\AppData\Local\Programs\DeepSeek Harness\*") do (
    if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"
  )
  if "%NODE_EXE%"=="node.exe" (
    echo.
    echo   [X] 找不到 Node.js。
    echo.
    echo   装一个再来：https://nodejs.org
    echo   选 LTS 版本，一路下一步即可。
    echo.
    pause
    exit /b 1
  )
)

echo   用：%NODE_EXE%
echo.

"%NODE_EXE%" "%~dp0install.mjs"
set RC=%ERRORLEVEL%

echo.
if "%RC%"=="0" (
  echo   ============================================
  echo     装好了
  echo   ============================================
  echo.
  echo   接下来：
  echo.
  echo     1. 完全退出 DeepSeek Harness
  echo        （托盘里也退），重新打开
  echo     2. 设置 - 养鱼经济学
  echo        能看到那一节就说明生效了
  echo.
) else (
  echo   ============================================
  echo     安装没成功（错误码 %RC%）
  echo   ============================================
  echo.
  echo   看看上面红字说了什么。
  echo.
)

pause
