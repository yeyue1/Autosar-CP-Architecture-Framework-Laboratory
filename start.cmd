@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "NODE_BIN="

where node >nul 2>nul
if not errorlevel 1 (
  set "NODE_BIN=node"
) else if exist "C:\Program Files\nodejs\node.exe" (
  set "NODE_BIN=C:\Program Files\nodejs\node.exe"
)

if not defined NODE_BIN (
  echo Node.js was not found in PATH or at C:\Program Files\nodejs\node.exe
  exit /b 1
)

"%NODE_BIN%" "%SCRIPT_DIR%server.mjs" --open %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo Server exited with code %EXIT_CODE%.
)
exit /b %EXIT_CODE%
