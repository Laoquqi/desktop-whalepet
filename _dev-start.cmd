@echo off
chcp 65001 >nul
title 大肥鱼桌宠 - 源码模式

rem ===========================================================================
rem  源码模式启动（改完代码不用打包就能测）
rem
rem  为什么需要这个 .cmd 而不是直接 npm start：
rem    ① 有些环境设了 ELECTRON_RUN_AS_NODE=1 —— Electron 会被当成纯 Node 跑，
rem       窗口一个都不出来，也不报错。这里先清掉。
rem    ② NODE_OPTIONS 里如果有 --require 之类的钩子，也会干扰主进程，一并清掉。
rem    ③ 直接调 dist\electron.exe，绕开 npm / npx 的 PATH 依赖。
rem
rem  ⚠️ 先完全退出旧的「大肥鱼桌宠.exe」，否则单实例锁会让这次启动直接退出，
rem     只是在旧进程里多开一个窗口 —— 那还是旧代码，白测。
rem ===========================================================================

set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
set "ELECTRON_ENABLE_LOGGING="

cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [x] 找不到 node_modules\electron\dist\electron.exe
  echo     先在项目目录跑一次：npm install
  pause
  exit /b 1
)

echo 正在以源码模式启动（日志：%%APPDATA%%\大肥鱼桌宠\pet.log）
echo 关掉桌宠窗口即退出。本窗口保持打开可以看到主进程输出。
echo.

"node_modules\electron\dist\electron.exe" .

if errorlevel 1 (
  echo.
  echo [x] 退出码 %errorlevel% —— 起不来时看上面几行输出
  pause
)
