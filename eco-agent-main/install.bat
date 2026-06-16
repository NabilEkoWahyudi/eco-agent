@echo off
setlocal

echo.
echo   ══════════════════════════════════════
echo    🌿 ECO AGENT — Installer (Windows)
echo   ══════════════════════════════════════
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo   [ERROR] Node.js not found!
  echo   Install it at: https://nodejs.org
  pause & exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo   [OK] Node.js %NODE_VER% found

where npm >nul 2>&1
if %errorlevel% neq 0 (
  echo   [ERROR] npm not found!
  pause & exit /b 1
)
echo   [OK] npm found
echo.

echo   [..] Installing dependencies...
call npm install --silent
if %errorlevel% neq 0 ( echo   [ERROR] npm install failed! & pause & exit /b 1 )
echo   [OK] Dependencies installed

echo   [..] Building...
call npm run build
if %errorlevel% neq 0 ( echo   [ERROR] Build failed! & pause & exit /b 1 )
echo   [OK] Build complete

echo   [..] Installing 'eco' command globally...
call npm install -g .
if %errorlevel% neq 0 (
  echo   [ERROR] Global install failed.
  echo   Try running CMD as Administrator and retry.
  pause & exit /b 1
)

echo   [OK] 'eco' command installed!
echo.
echo   ══════════════════════════════════════
echo    🌿 Eco Agent is ready!
echo   ══════════════════════════════════════
echo.
echo   Run with:
echo     eco              - open Eco Agent
echo     eco --resume     - resume last session
echo     eco --reset      - reset configuration
echo     eco --help       - show all options
echo.
echo   To uninstall:
echo     npm uninstall -g eco-agent
echo.
pause
