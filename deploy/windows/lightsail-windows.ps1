# browser-mcp: Lightsail / EC2 Windows Server setup (Windows Server 2022 or 2025, PowerShell 5.1).
#
# Why Windows instead of the Linux image: login.coupang.com answers 403 to any Linux desktop
# User-Agent before a page even loads, and Akamai's sensor rejects a browser whose User-Agent
# claims one OS while WebGL, fonts and navigator.platform say another. A Windows host needs no
# disguise: Chrome reports real Windows values everywhere, so only the automation flag is removed.
#
# Measured 2026-11-04: this is NOT enough for coupang.com. On a Lightsail Windows instance the home
# HTML loads but every /n-api/* call and the login SMS-code request answer 403, and a person opening
# Chrome by hand over RDP on the same instance gets the same result: Akamai rejects the AWS datacenter
# IP and VM environment itself, not the automation. For coupang.com run the server on a real machine
# on a home/office network instead. This script remains useful for other sites that need Windows.
#
# How to run (once, as Administrator, inside an RDP session of the account that will keep
# the browser's desktop — "Administrator" unless you changed AUTOLOGON_USER):
#   1. Lightsail console > the instance > Connect using RDP (or any RDP client).
#   2. Copy this file to the instance, fill in the settings below.
#   3. In an elevated PowerShell:  Set-ExecutionPolicy Bypass -Scope Process -Force; .\lightsail-windows.ps1
#
# It installs Git, Node.js LTS, Google Chrome and Caddy (through Chocolatey), clones the
# repository to $APP_DIR, writes .env, builds, opens ports 80/443 in Windows Firewall and
# registers three scheduled tasks:
#   browser-mcp server  - at logon of AUTOLOGON_USER, runs deploy\windows\run-server.ps1 (visible Chrome
#                         needs an interactive desktop, which is why the account auto-logs on after a reboot)
#   browser-mcp caddy   - at startup as SYSTEM, HTTPS for $DOMAIN in front of 127.0.0.1:3000
#   browser-mcp update  - hourly as SYSTEM, deploy\windows\update.ps1 (rebuild when the branch moved)
# Progress is written to C:\browser-mcp-setup.log. Re-running the script is safe; it keeps an existing .env.
#
# Afterwards: point the DNS A record of $DOMAIN at the instance's static IP, open only 80, 443 and
# 3389 (RDP, ideally restricted to your IP) in the Lightsail firewall.
# When you disconnect RDP, run deploy\windows\disconnect-rdp.cmd instead of closing the window, so the
# desktop keeps rendering for Chrome (a plain disconnect locks the session and screenshots go blank).

# ---- settings ------------------------------------------------------------------
$DOMAIN = "browser.example.com"           # public host name whose DNS A record points at this instance
$STATIC_TOKENS = ""                       # optional "token:user,token2:user2" (16+ character random tokens)
$ISSUE_TOKENS = $false                    # $true: the server issues tokens via POST /tokens and lists them via GET /tokens
$ADMIN_TOKEN = ""                         # secret (16+ characters) required to call /tokens; empty = open endpoint (sandbox only)
$AUTOLOGON_USER = "Administrator"         # account whose desktop hosts the browser
$AUTOLOGON_PASSWORD = ""                  # its password (Lightsail: instance page > Connect > Retrieve default password);
                                          # stored in the registry for automatic logon after a reboot; empty = no auto-logon,
                                          # then someone must log in via RDP after every reboot before the server starts
$REPO_URL = "https://github.com/cheesecrust/browser-mcp.git"
$BRANCH = "main"
$AUTO_UPDATE = $true                      # hourly: pull the branch and rebuild when it moved
$APP_DIR = "C:\browser-mcp"
# --------------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$LOG = "C:\browser-mcp-setup.log"
Start-Transcript -Path $LOG -Append | Out-Null

function Step($text) { Write-Host "== $text" }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

try {
  Step "browser-mcp Windows setup started $(Get-Date -Format s)"

  if (-not $DOMAIN -or $DOMAIN -eq "browser.example.com") { throw "set DOMAIN to your real host name before running the script" }
  if (-not $STATIC_TOKENS -and -not $ISSUE_TOKENS) {
    throw "set STATIC_TOKENS or ISSUE_TOKENS = `$true, otherwise nobody can log in"
  }
  if ($ADMIN_TOKEN -and $ADMIN_TOKEN.Length -lt 16) { throw "ADMIN_TOKEN must be at least 16 characters" }
  $me = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal $me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "run this script from an elevated (Administrator) PowerShell"
  }

  Step "setting the clock to Korea Standard Time (a UTC clock is one of the signals sites use to spot servers)"
  Set-TimeZone -Id "Korea Standard Time"

  if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
    Step "installing Chocolatey"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
    Invoke-Expression ((New-Object Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    Refresh-Path
  }

  Step "installing Git, Node.js LTS, Google Chrome and Caddy"
  choco install -y --no-progress git nodejs-lts caddy
  # Google replaces the Chrome installer without bumping the package, so its checksum is often stale.
  choco install -y --no-progress --ignore-checksums googlechrome
  Refresh-Path
  foreach ($tool in 'git', 'node', 'npm', 'caddy') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH after installation; open a new PowerShell and run the script again" }
  }
  $chrome = Get-ChildItem "C:\Program Files\Google\Chrome\Application\chrome.exe", "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $chrome) { throw "Google Chrome was not installed" }

  Step "fetching $REPO_URL ($BRANCH)"
  if (Test-Path "$APP_DIR\.git") {
    git -C $APP_DIR fetch --depth 1 origin $BRANCH
    git -C $APP_DIR reset --hard "origin/$BRANCH"
  } else {
    git clone --depth 1 --branch $BRANCH $REPO_URL $APP_DIR
  }

  if (-not (Test-Path "$APP_DIR\.env")) {
    Step "writing .env"
    $lines = @(
      "DOMAIN=$DOMAIN",
      "BROWSER_MCP_PUBLIC_URL=https://$DOMAIN",
      "BROWSER_MCP_HTTP=1",
      "BROWSER_MCP_HOST=127.0.0.1",
      "BROWSER_MCP_PORT=3000",
      "BROWSER_MCP_DATA_DIR=$APP_DIR\data",
      # Real Chrome with a window; nothing else is overridden on Windows (no user agent, no screen size,
      # no software WebGL): the values Chrome reports are the real ones, which is the point of this host.
      "BROWSER_MCP_HEADLESS=0",
      "BROWSER_MCP_CHANNEL=chrome",
      "BROWSER_MCP_BROWSER_ARGS=--disable-blink-features=AutomationControlled",
      "BROWSER_MCP_LOCALE=ko-KR"
    )
    if ($STATIC_TOKENS) { $lines += "BROWSER_MCP_TOKENS=$STATIC_TOKENS" }
    if ($ISSUE_TOKENS) { $lines += "BROWSER_MCP_ISSUE_TOKENS=1" }
    if ($ADMIN_TOKEN) { $lines += "BROWSER_MCP_ADMIN_TOKEN=$ADMIN_TOKEN" }
    Set-Content -Path "$APP_DIR\.env" -Value $lines -Encoding ASCII
    # Only administrators may read the secrets.
    icacls "$APP_DIR\.env" /inheritance:r /grant:r "Administrators:F" /grant:r "SYSTEM:F" /grant:r "${AUTOLOGON_USER}:R" | Out-Null
  } else {
    Step "keeping the existing .env"
  }

  Step "installing dependencies and building"
  Push-Location $APP_DIR
  try {
    npm ci --no-audit --no-fund
    npm run build
  } finally { Pop-Location }
  New-Item -ItemType Directory -Force -Path "$APP_DIR\data", "$APP_DIR\logs" | Out-Null

  Step "opening ports 80 and 443 in Windows Firewall"
  foreach ($port in 80, 443) {
    $name = "browser-mcp caddy $port"
    if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow | Out-Null
    }
  }

  if ($AUTOLOGON_PASSWORD) {
    Step "enabling automatic logon of $AUTOLOGON_USER so the browser has a desktop after a reboot"
    $winlogon = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
    Set-ItemProperty $winlogon -Name AutoAdminLogon -Value "1" -Type String
    Set-ItemProperty $winlogon -Name DefaultUserName -Value $AUTOLOGON_USER -Type String
    Set-ItemProperty $winlogon -Name DefaultDomainName -Value $env:COMPUTERNAME -Type String
    Set-ItemProperty $winlogon -Name DefaultPassword -Value $AUTOLOGON_PASSWORD -Type String
    # Do not lock the screen after idle time; a locked desktop stops Chrome from painting.
    Set-ItemProperty "HKCU:\Control Panel\Desktop" -Name ScreenSaveActive -Value "0" -Type String -ErrorAction SilentlyContinue
  } else {
    Step "AUTOLOGON_PASSWORD is empty: after a reboot, log in via RDP once and the server task starts with that logon"
  }

  Step "registering scheduled tasks"
  $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $noLimit = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable

  $serverAction = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$APP_DIR\deploy\windows\run-server.ps1`"" -WorkingDirectory $APP_DIR
  $serverTrigger = New-ScheduledTaskTrigger -AtLogOn -User $AUTOLOGON_USER
  $serverPrincipal = New-ScheduledTaskPrincipal -UserId $AUTOLOGON_USER -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName "browser-mcp server" -Action $serverAction -Trigger $serverTrigger -Principal $serverPrincipal -Settings $noLimit -Force | Out-Null

  $caddyExe = (Get-Command caddy).Source
  $caddyAction = New-ScheduledTaskAction -Execute $caddyExe -Argument "run --config `"$APP_DIR\deploy\windows\Caddyfile`" --envfile `"$APP_DIR\.env`"" -WorkingDirectory "$APP_DIR\data"
  $caddyTrigger = New-ScheduledTaskTrigger -AtStartup
  $systemPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName "browser-mcp caddy" -Action $caddyAction -Trigger $caddyTrigger -Principal $systemPrincipal -Settings $noLimit -Force | Out-Null

  if ($AUTO_UPDATE) {
    $updateAction = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$APP_DIR\deploy\windows\update.ps1`"" -WorkingDirectory $APP_DIR
    $updateTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1)
    $updateSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName "browser-mcp update" -Action $updateAction -Trigger $updateTrigger -Principal $systemPrincipal -Settings $updateSettings -Force | Out-Null
    Step "hourly auto-update installed (scheduled task 'browser-mcp update')"
  } else {
    Unregister-ScheduledTask -TaskName "browser-mcp update" -Confirm:$false -ErrorAction SilentlyContinue
  }

  Step "starting the server and Caddy"
  Start-ScheduledTask -TaskName "browser-mcp caddy"
  Start-ScheduledTask -TaskName "browser-mcp server"

  Step "waiting for the server to report healthy"
  $health = $null
  foreach ($i in 1..30) {
    try {
      $health = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3000/healthz" -TimeoutSec 3).Content
      break
    } catch { Start-Sleep -Seconds 2 }
  }
  if ($health) { Step "server healthy: $health" }
  else { Write-Warning "the server did not answer on port 3000 within 60 seconds; check $APP_DIR\logs\server.log and the task 'browser-mcp server' in Task Scheduler" }

  Step "done $(Get-Date -Format s). Check https://$DOMAIN/healthz once DNS points here; server log: $APP_DIR\logs\server.log"
} finally {
  Stop-Transcript | Out-Null
}
