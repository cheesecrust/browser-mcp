# Starts the browser-mcp HTTP server with the variables from .env (Node does not read .env itself;
# on Linux docker compose does this). Run by the scheduled task "browser-mcp server" in the desktop
# session of the auto-logon user, so that Chrome gets a real window. Safe to run by hand as well.
$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $AppDir

Get-Content "$AppDir\.env" | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
  }
}

New-Item -ItemType Directory -Force -Path "$AppDir\logs" | Out-Null
$log = "$AppDir\logs\server.log"
# Keep the log from growing without bound: start over above 20 MB.
if ((Test-Path $log) -and (Get-Item $log).Length -gt 20MB) { Move-Item -Force $log "$AppDir\logs\server.previous.log" }

# All server output goes to stderr (stdout is the MCP channel in stdio mode); cmd merges both into the log.
& cmd.exe /c "node dist\index.js --http >> `"$log`" 2>&1"
exit $LASTEXITCODE
