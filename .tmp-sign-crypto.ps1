# Proves the signing pipeline produces cryptographically valid Authenticode signatures,
# without adding the throwaway cert to any trusted root (that opens a blocking Windows
# security dialog). Integrity is checked with SignedCms.CheckSignature(verifySignatureOnly),
# which validates the signature bytes against the file content and needs no trust chain.
$ErrorActionPreference = 'Continue'
$root = 'D:\Applications\tm-data-manager'
$release = Join-Path $root 'src-tauri\target\release'
$setup = Join-Path $release 'bundle\nsis\UDMT_0.1.0_x64-setup.exe'
$shell = Join-Path $release 'udmt-desktop.exe'
$subject = 'CN=UDMT Build Test, O=TM Data Test, C=VN'

function Remove-TestCert {
  Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -eq $subject } |
    ForEach-Object { Remove-Item (Join-Path $_.PSParentPath $_.Thumbprint) -Force -ErrorAction SilentlyContinue }
}

# Reads the WIN_CERTIFICATE (Authenticode) blob out of a PE file and checks its signature.
function Test-AuthenticodeIntegrity([string] $path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
  # PE signature + COFF header (20) + optional header size (2 at 0x14).
  $optSize = [BitConverter]::ToUInt16($bytes, $peOffset + 20)
  $magic = [BitConverter]::ToUInt16($bytes, $peOffset + 24)
  $dataDirOffset = if ($magic -eq 0x20b) { $peOffset + 24 + 112 } else { $peOffset + 24 + 96 }
  # Security directory is entry 4 in the data directory array (8 bytes each).
  $secEntry = $dataDirOffset + (4 * 8)
  $certOffset = [BitConverter]::ToUInt32($bytes, $secEntry)
  $certSize = [BitConverter]::ToUInt32($bytes, $secEntry + 4)
  if ($certOffset -eq 0 -or $certSize -eq 0) { return 'no signature present' }

  # WIN_CERTIFICATE: dwLength(4) wRevision(2) wCertificateType(2) then the PKCS#7 blob.
  $blobLength = [BitConverter]::ToUInt32($bytes, $certOffset) - 8
  $blob = New-Object byte[] $blobLength
  [Array]::Copy($bytes, $certOffset + 8, $blob, 0, $blobLength)

  $cms = New-Object System.Security.Cryptography.Pkcs.SignedCms
  $cms.Decode($blob)
  $signer = $cms.SignerInfos[0]
  try {
    $signer.CheckSignature($true)
    return "VALID (signer: $($signer.Certificate.Subject), digest: $($signer.DigestAlgorithm.FriendlyName), sigs: $($cms.SignerInfos.Count), timestamped: $([bool]$signer.UnsignedAttributes))"
  } catch {
    return "INVALID ($($_.Exception.Message))"
  }
}

Remove-TestCert

'=== 1. throwaway cert in CurrentUser\My (no trust import) ==='
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject `
  -CertStoreLocation 'Cert:\CurrentUser\My' -KeyUsage DigitalSignature `
  -KeyExportPolicy Exportable -KeyLength 2048 -KeyAlgorithm RSA -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddDays(2)
"thumbprint: $($cert.Thumbprint)"

'=== 2. sign via scripts/sign-windows.mjs (thumbprint path) ==='
$env:UDMT_SIGN_CERT = $cert.Thumbprint
$env:UDMT_SIGN_CERT_SUBJECT = ''
$env:UDMT_SIGN_CERT_MACHINE = ''
Push-Location $root
node scripts/sign-windows.mjs $setup $shell 2>&1 | ForEach-Object { "  $_" }
$code = $LASTEXITCODE
Pop-Location
"exit code: $code"

'=== 3. signature integrity (crypto, trust-independent) ==='
foreach ($f in $setup, $shell) {
  "--- $(Split-Path $f -Leaf): $(Test-AuthenticodeIntegrity $f)"
  "    Get-AuthenticodeSignature: $((Get-AuthenticodeSignature $f).Status) [untrusted root => not Valid, expected]"
}

'=== 4. tampered copy must be detected ==='
$tampered = Join-Path $env:TEMP 'udmt-tampered.exe'
Copy-Item $shell $tampered -Force
$raw = [IO.File]::ReadAllBytes($tampered)
# Flip a byte well inside the code section but away from headers and the cert table.
$raw[0x400] = $raw[0x400] -bxor 0xFF
[IO.File]::WriteAllBytes($tampered, $raw)
"--- tampered: $(Test-AuthenticodeIntegrity $tampered)"
Remove-Item $tampered -Force

'=== 5. cleanup ==='
Remove-TestCert
"test certs remaining: $(@(Get-ChildItem Cert:\CurrentUser\My, Cert:\CurrentUser\Root -ErrorAction SilentlyContinue | Where-Object { $_.Subject -eq $subject }).Count)"
