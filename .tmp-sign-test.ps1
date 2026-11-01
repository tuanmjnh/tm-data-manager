# Verifies scripts/sign-windows.mjs end to end with a throwaway self-signed cert.
# The cert is created in CurrentUser\My and removed at the end; it never leaves this machine.
$ErrorActionPreference = 'Continue'
$root = 'D:\Applications\tm-data-manager'
$release = Join-Path $root 'src-tauri\target\release'
$setup = Join-Path $release 'bundle\nsis\UDMT_0.1.0_x64-setup.exe'
$subject = 'CN=UDMT Build Test, O=TM Data Test, C=VN'

'=== 0. current signature state (expect NotSigned) ==='
(Get-AuthenticodeSignature $setup).Status

'=== 1. create a throwaway self-signed code-signing cert ==='
$existing = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -eq $subject }
foreach ($c in $existing) { Remove-Item "Cert:\CurrentUser\My\$($c.Thumbprint)" -Force }

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $subject `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyUsage DigitalSignature `
  -KeyExportPolicy Exportable `
  -KeyLength 2048 `
  -KeyAlgorithm RSA `
  -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddDays(2)
"thumbprint: $($cert.Thumbprint)"

'=== 2. run the signing script with the same env vars the build uses ==='
$env:UDMT_SIGN_CERT_SUBJECT = 'UDMT Build Test'
$env:UDMT_SIGN_CERT_STORE = 'CurrentUser'
$env:UDMT_SIGN_TIMESTAMP_URL = 'http://timestamp.digicert.com'

Push-Location $root
node scripts/sign-windows.mjs $setup (Join-Path $release 'udmt-desktop.exe')
$signExit = $LASTEXITCODE
Pop-Location
"sign-windows.mjs exit code: $signExit"

'=== 3. verify Authenticode on both artifacts ==='
foreach ($f in $setup, (Join-Path $release 'udmt-desktop.exe')) {
  $sig = Get-AuthenticodeSignature $f
  "--- $(Split-Path $f -Leaf)"
  "    status: $($sig.Status)"
  "    signer: $($sig.SignerCertificate.Subject)"
  "    timestamp: $($sig.TimeStamperCertificate.NotAfter)"
  "    isOSBinary: $($sig.IsOSBinary)"
}

'=== 4. negative check: a tampered copy must fail verification ==='
$tampered = Join-Path $env:TEMP 'udmt-tampered-setup.exe'
Copy-Item $setup $tampered -Force
$bytes = [IO.File]::ReadAllBytes($tampered)
$bytes[$bytes.Length - 500] = $bytes[$bytes.Length - 500] -bxor 0xFF
[IO.File]::WriteAllBytes($tampered, $bytes)
"tampered status: $((Get-AuthenticodeSignature $tampered).Status)"
Remove-Item $tampered -Force -ErrorAction SilentlyContinue

'=== 5. remove the throwaway cert ==='
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force
$still = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -eq $subject }
"cert removed: $(-not $still)"
# The signature stays valid-looking but untrusted; report what a recipient sees.
"post-removal status on setup: $((Get-AuthenticodeSignature $setup).Status)"
