# Pulls the deployed branch and rebuilds when it moved, then restarts the server task.
# Run hourly by the scheduled task "browser-mcp update" (installed by lightsail-windows.ps1); safe to run by hand.
$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $AppDir
$log = "$AppDir\logs\update.log"
New-Item -ItemType Directory -Force -Path "$AppDir\logs" | Out-Null

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
git fetch --depth 1 --quiet origin $branch
if ((git rev-parse HEAD).Trim() -eq (git rev-parse "origin/$branch").Trim()) { exit 0 }

"== updating to $((git rev-parse --short "origin/$branch").Trim()) $(Get-Date -Format s)" | Tee-Object -FilePath $log -Append
git reset --hard --quiet "origin/$branch"
# Through cmd.exe: Windows PowerShell 5.1 turns stderr lines (npm warnings) into terminating errors when redirected.
& cmd.exe /c "npm ci --no-audit --no-fund >> `"$log`" 2>&1"
if ($LASTEXITCODE -ne 0) { throw "npm ci failed, see $log" }
& cmd.exe /c "npm run build >> `"$log`" 2>&1"
if ($LASTEXITCODE -ne 0) { throw "npm run build failed, see $log" }

# Stop the running server (the task's cmd/node pair) and let the task start it again. The task
# restarts on its own after the process ends, Start-ScheduledTask just makes that immediate.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*dist\index.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName "browser-mcp server" -ErrorAction SilentlyContinue
"== updated $(Get-Date -Format s)" | Tee-Object -FilePath $log -Append
