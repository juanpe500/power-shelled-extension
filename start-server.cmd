@echo off
setlocal
cd /d "%~dp0server"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)

rem --headless : launch the server DETACHED, with no visible window and no TUI
rem              dashboard. Output is redirected to server\server.log / server.err.log.
rem              Stop it with:  taskkill /IM node.exe   (or via Task Manager).
set "MODE=%~1"
if /i "%MODE%"=="--headless" goto headless
if /i "%MODE%"=="-headless"  goto headless
if /i "%MODE%"=="/headless"  goto headless
goto normal

:headless
set "CT_NO_TUI=1"
echo Starting chrome-terminal server headless ^(no window, no dashboard^)...
powershell -NoProfile -Command "Start-Process node -ArgumentList 'server.js' -WorkingDirectory '%~dp0server' -WindowStyle Hidden -RedirectStandardOutput '%~dp0server\server.log' -RedirectStandardError '%~dp0server\server.err.log'"
echo Launched in background.  Logs: server\server.log  ^|  Stop: taskkill /IM node.exe
goto :eof

:normal
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
