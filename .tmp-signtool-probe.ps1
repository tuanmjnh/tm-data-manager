$ErrorActionPreference = 'Continue'
$setup = 'D:\Applications\tm-data-manager\src-tauri\target\release\bundle\nsis\UDMT_0.1.0_x64-setup.exe'
$subject = 'CN=UDMT Build Test, O=TM Data Test, C=VN'
$signtool = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe'

$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject `
  -CertStoreLocation 'Cert:\CurrentUser\My' -KeyUsage DigitalSignature `
  -KeyExportPolicy Exportable -KeyLength 2048 -KeyAlgorithm RSA -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddDays(2)
"thumbprint: $($cert.Thumbprint)"
"store location of that thumbprint: "
Get-ChildItem Cert:\CurrentUser\My | Where-Object Thumbprint -eq $cert.Thumbprint | ForEach-Object { '  found in CurrentUser\My' }

'--- A: current script arguments (/n subject /s CurrentUser) ---'
& $signtool sign /fd sha256 /td sha256 /tr http://timestamp.digicert.com /n 'UDMT Build Test' /s CurrentUser $setup 2>&1
"A exit: $LASTEXITCODE"

'--- B: store name My, current-user implicit ---'
& $signtool sign /fd sha256 /td sha256 /tr http://timestamp.digicert.com /n 'UDMT Build Test' /s My $setup 2>&1
"B exit: $LASTEXITCODE"
if ($LASTEXITCODE -eq 0) {
  $sig = Get-AuthenticodeSignature $setup
  "   status: $($sig.Status)"
  "   signer: $($sig.SignerCertificate.Subject)"
  "   timestamp: $($sig.TimeStamperCertificate.NotAfter)"
}

'--- cleanup: remove cert, keep whatever signature landed ---'
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force
"removed: $(-not (Get-ChildItem Cert:\CurrentUser\My | Where-Object Thumbprint -eq $cert.Thumbprint))"
