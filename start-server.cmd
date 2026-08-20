@echo off
cd /d "%~dp0server"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
:loop
echo.
echo Starting chrome-terminal server. Leave this window open.
echo (Close it to stop all terminals.)
echo.
node server.js
if %ERRORLEVEL% EQU 42 (
  echo.
  echo Restarting server...
  goto loop
)
echo.
echo Server stopped. Press any key to close.
pause >nul
