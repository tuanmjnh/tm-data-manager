# End-to-end proof that the signing pipeline produces a VALID Authenticode signature.
# Temporarily trusts the throwaway self-signed cert in CurrentUser stores, then removes
# both the trust entry and the cert. Nothing is left on the machine.
$ErrorActionPreference = 'Continue'
$root = 'D:\Applications\tm-data-manager'
$release = Join-Path $root 'src-tauri\target\release'
$setup = Join-Path $release 'bundle\nsis\UDMT_0.1.0_x64-setup.exe'
$shell = Join-Path $release 'udmt-desktop.exe'
$subject = 'CN=UDMT Build Test, O=TM Data Test, C=VN'

function Cleanup-Certs {
  Get-ChildItem Cert:\CurrentUser\My, Cert:\CurrentUser\Root -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -eq $subject } |
    ForEach-Object {
      # Remove trust first so the cert can be dropped from My afterwards.
      Remove-Item "Cert:\CurrentUser\Root\$($_.Thumbprint)" -Force -ErrorAction SilentlyContinue
      Remove-Item "Cert:\CurrentUser\My\$($_.Thumbprint)" -Force -ErrorAction SilentlyContinue
    }
}

Cleanup-Certs

'=== 1. create the throwaway cert and trust it locally ==='
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject `
  -CertStoreLocation 'Cert:\CurrentUser\My' -KeyUsage DigitalSignature `
  -KeyExportPolicy Exportable -KeyLength 2048 -KeyAlgorithm RSA -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddDays(2)
$cerPath = Join-Path $env:TEMP 'udmt-test-cert.cer'
Export-Certificate -Cert $cert -FilePath $cerPath -Force | Out-Null
Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
Remove-Item $cerPath -Force
"thumbprint: $($cert.Thumbprint) (trusted in CurrentUser\Root for this test only)"

'=== 2. sign through the project script ==='
$env:UDMT_SIGN_CERT = $cert.Thumbprint   # exercises the thumbprint path (/sha1, not /f)
$env:UDMT_SIGN_CERT_SUBJECT = ''
$env:UDMT_SIGN_CERT_MACHINE = ''
Push-Location $root
node scripts/sign-windows.mjs $setup $shell
$code = $LASTEXITCODE
Pop-Location
"sign-windows.mjs exit code: $code"

'=== 3. Authenticode must now be Valid, with a signer and a timestamp ==='
$ok = $true
foreach ($f in $setup, $shell) {
  $sig = Get-AuthenticodeSignature $f
  "--- $(Split-Path $f -Leaf)"
  "    status:     $($sig.Status)"
  "    signer:     $($sig.SignerCertificate.Subject)"
  "    timestamp:  $($sig.TimeStamperCertificate.NotAfter)"
  if ($sig.Status -ne 'Valid') { $ok = $false }
}
"both artifacts Valid: $ok"

'=== 4. a single flipped byte must be detected as HashMismatch ==='
$tampered = Join-Path $env:TEMP 'udmt-tampered-setup.exe'
Copy-Item $setup $tampered -Force
$bytes = [IO.File]::ReadAllBytes($tampered)
$i = [int]($bytes.Length / 2)
$bytes[$i] = $bytes[$i] -bxor 0xFF
[IO.File]::WriteAllBytes($tampered, $bytes)
"tampered status: $((Get-AuthenticodeSignature $tampered).Status)"
Remove-Item $tampered -Force -ErrorAction SilentlyContinue

'=== 5. remove test trust and cert; report what an unsigned machine would see ==='
Cleanup-Certs
$left = @(Get-ChildItem Cert:\CurrentUser\My, Cert:\CurrentUser\Root -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -eq $subject })
"test certs remaining: $($left.Count)"
"status without the cert: $((Get-AuthenticodeSignature $setup).Status)"
