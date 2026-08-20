# Starts the chrome-terminal PTY server. Leave this window open while using the extension.
# Loops on exit code 42 so the dashboard's Ctrl+R can restart the server in place.
Set-Location "$PSScriptRoot\server"
if (-not (Test-Path node_modules)) { npm install }
do {
  node server.js
} while ($LASTEXITCODE -eq 42)
