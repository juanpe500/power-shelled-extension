# Starts the chrome-terminal PTY server. Leave this window open while using the extension.
Set-Location "$PSScriptRoot\server"
if (-not (Test-Path node_modules)) { npm install }
node server.js
