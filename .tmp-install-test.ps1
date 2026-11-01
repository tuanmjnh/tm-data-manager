# Full install lifecycle test for the UDMT NSIS installer, run as a NORMAL user
# (no elevation anywhere in this script).
$ErrorActionPreference = 'Continue'
$setup = 'D:\Applications\tm-data-manager\src-tauri\target\release\bundle\nsis\UDMT_0.1.0_x64-setup.exe'
$installDir = Join-Path $env:LOCALAPPDATA 'UDMT'
$uninstaller = Join-Path $installDir 'uninstall.exe'
$dataDir = Join-Path $env:APPDATA 'udmt'

function Show-Label($path) {
  if (-not (Test-Path $path)) { return "$path => MISSING" }
  $line = (icacls $path | Select-String 'Mandatory Label').ToString()
  return "$path => $($line -replace '\s+', ' ')"
}

'=== 0. preconditions ==='
'elevated: ' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')
"installer: $(if (Test-Path $setup) { (Get-Item $setup).Length } else { 'MISSING' }) bytes"
Show-Label $setup

'=== 1. purge any previous install ==='
if (Test-Path $uninstaller) {
  # /S silent, /CURRENTUSER keeps it per-user so nothing prompts for UAC.
  Start-Process -FilePath $uninstaller -ArgumentList '/S','/CURRENTUSER' -Wait
  Start-Sleep -Seconds 4
}
Start-Sleep -Seconds 1
"installed dir left after uninstall: $(Test-Path $installDir)"
if (Test-Path $installDir) { Remove-Item $installDir -Recurse -Force -ErrorAction SilentlyContinue }

'=== 2. install silently (no elevation) ==='
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $setup -ArgumentList '/S','/CURRENTUSER' -Wait -PassThru
$sw.Stop()
"exit code: $($p.ExitCode)  elapsed: $([math]::Round($sw.Elapsed.TotalSeconds,1))s"

'=== 3. verify installed payload ==='
if (Test-Path $installDir) {
  Get-ChildItem $installDir -Recurse -File | Measure-Object -Property Length -Sum |
    ForEach-Object { "files: $($_.Count), total MB: $([math]::Round($_.Sum/1MB,1))" }
  foreach ($f in 'udmt-desktop.exe','runtime\node.exe','runtime\udmt-core.cjs','runtime\ui\index.html','uninstall.exe') {
    $full = Join-Path $installDir $f
    "  $(if (Test-Path $full) { 'OK  ' } else { 'MISS' }) $f"
  }
  Show-Label (Join-Path $installDir 'udmt-desktop.exe')
} else { 'INSTALL FAILED: no install dir' }

'=== 4. launch and check the UI actually loads ==='
$shellLog = Join-Path $dataDir 'logs\desktop-shell.log'
Remove-Item $shellLog -ErrorAction SilentlyContinue
$app = Start-Process -FilePath (Join-Path $installDir 'udmt-desktop.exe') -PassThru
Start-Sleep -Seconds 10
$alive = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
"process alive: $([bool]$alive)  title: '$($alive.MainWindowTitle)'"
if (Test-Path $shellLog) { Get-Content $shellLog | ForEach-Object { "  log: $_" } }
$port = if (Test-Path $shellLog) { (Select-String -Path $shellLog -Pattern 'port=(\d+)' | Select-Object -Last 1).Matches.Groups[1].Value }
if ($port) {
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 10
    "health: app=$($h.app) ok=$($h.ok)"
    $page = Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 10
    "index: HTTP $($page.StatusCode), nuxt root: $($page.Content -match 'id=""__nuxt""')"
  } catch { "HTTP probe failed: $($_.Exception.Message)" }
  # WebView2 children prove the embedded browser started (the blank-window failure).
  $wv = (Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
    Where-Object { $_.CommandLine -like '*UDMT*WebView2*' }).Count
  "msedgewebview2 children on UDMT profile: $wv"
} else { 'no port in the shell log' }

'=== 5. close the app ==='
Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*UDMT\runtime\udmt-core.cjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

'=== 6. uninstall and confirm the folder is gone ==='
if (Test-Path $uninstaller) {
  $u = Start-Process -FilePath $uninstaller -ArgumentList '/S','/CURRENTUSER' -Wait -PassThru
  Start-Sleep -Seconds 5
  "uninstall exit code: $($u.ExitCode)"
  "install dir removed: $(-not (Test-Path $installDir))"
  $left = @()
  if (Test-Path $installDir) { $left = Get-ChildItem $installDir -Recurse -File | Select-Object -ExpandProperty FullName }
  if ($left.Count -gt 0) { "left behind:"; $left | ForEach-Object { "  $_" } }
} else { 'uninstaller missing' }
