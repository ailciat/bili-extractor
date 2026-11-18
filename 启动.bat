@echo off
cd /d "%~dp0"
title 提炼 · B站视频/音频/封面提取

echo.
echo   ============================================
echo      提炼 · B站视频 / 音频 / 封面提取
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 ^(
    echo   [错误] 没有检测到 Node.js
    echo.
    echo   请先安装 Node.js ^(建议 18 以上版本^):
    echo   https://nodejs.org/zh-cn
    echo.
    echo   安装完成后重新双击本文件即可。
    echo.
    pause
    exit /b 1
^)

rem 首次运行会自动补齐依赖（二维码 / ffmpeg），之后每次只是秒级检查
node scripts\ensure-deps.js
if errorlevel 1 ^(
    echo   [提示] 依赖检查出错，程序仍会尝试启动。
^)

echo.
echo   正在启动，浏览器会自动打开界面...
echo   关闭本窗口即可退出程序。
echo.

node server.js

echo.
echo   服务已停止。
pause
