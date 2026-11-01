$ErrorActionPreference = 'Continue'

'--- signtool in Windows Kits ---'
$kits = 'C:\Program Files (x86)\Windows Kits\10\bin'
if (Test-Path $kits) {
  Get-ChildItem $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Select-Object -Last 3 -ExpandProperty FullName
} else { 'no Windows Kits' }

'--- WebView2 runtime ---'
$guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
foreach ($hive in 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients', 'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients', 'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients') {
  $p = Join-Path $hive $guid
  if (Test-Path $p) { 'found in ' + $hive + ' -> version ' + (Get-ItemProperty $p).pv }
}

'--- installed app present? ---'
$installed = Join-Path $env:LOCALAPPDATA 'UDMT'
if (Test-Path $installed) { 'installed at ' + $installed } else { 'not installed' }
