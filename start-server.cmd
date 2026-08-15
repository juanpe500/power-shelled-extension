@echo off
cd /d "%~dp0server"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo.
echo Starting chrome-terminal server. Leave this window open.
echo (Close it to stop all terminals.)
echo.
node server.js
echo.
echo Server stopped. Press any key to close.
pause >nul
