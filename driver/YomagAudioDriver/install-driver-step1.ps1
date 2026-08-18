# YomagAudioDriver test-signing setup - STEP 1 of 2
#
# Run this in an ELEVATED PowerShell window (right-click PowerShell ->
# "Run as Administrator"), from any directory.
#
# What it does, and why:
#   1. Creates a local, self-signed code-signing certificate. This driver
#      build isn't signed by a real certificate authority (that requires an
#      EV code-signing cert and, for kernel drivers, Microsoft's WHQL
#      attestation process) - a local test certificate is the standard
#      substitute for development.
#   2. Installs that certificate into this machine's Trusted Root and
#      Trusted Publisher stores, so Windows will trust signatures made
#      with it.
#   3. Generates a catalog file (.cat) for the driver package and signs it
#      with the test certificate - every driver package needs a signed
#      catalog to install, test-signed or not.
#   4. Turns on Windows "test signing" mode, which relaxes driver signature
#      enforcement to also accept test certificates like this one (real
#      Microsoft-signed drivers are unaffected).
#
# Effects on your system: a persistent "Test Mode" watermark on the
# desktop, and reduced driver signature enforcement, until you run
# `bcdedit /set testsigning off` and reboot again to turn it back off.
#
# After this script finishes: REBOOT, then run install-driver-step2.ps1
# (also elevated) to actually install the driver.

$ErrorActionPreference = "Stop"

$packageDir = Join-Path $PSScriptRoot "x64\Debug"
if (-not (Test-Path (Join-Path $packageDir "YomagAudioDriver.inf"))) {
    throw "Expected driver package at $packageDir - build the driver project first if this is missing."
}

$sdkBinCandidates = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending
$sdkBin = $null
foreach ($dir in $sdkBinCandidates) {
    $candidate = Join-Path $dir.FullName "x86"
    if (Test-Path (Join-Path $candidate "Inf2Cat.exe")) {
        $sdkBin = $candidate
        break
    }
}
if (-not $sdkBin) {
    throw "Could not find Inf2Cat.exe under Windows Kits 10 - is the Windows SDK/WDK installed?"
}

Write-Host "Using SDK tools from: $sdkBin"
Write-Host ""

Write-Host "1/5 Creating self-signed test certificate..."
$existing = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -eq "CN=YomagAudio Test Certificate" } |
    Select-Object -First 1
if ($existing) {
    Write-Host "    Reusing existing certificate (thumbprint $($existing.Thumbprint))"
    $cert = $existing
} else {
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject "CN=YomagAudio Test Certificate" `
        -CertStoreLocation Cert:\CurrentUser\My `
        -KeyUsage DigitalSignature `
        -FriendlyName "YomagAudio Test Certificate" `
        -NotAfter (Get-Date).AddYears(10)
}

$certPath = Join-Path $packageDir "YomagAudioTestCert.cer"
Export-Certificate -Cert $cert -FilePath $certPath | Out-Null
Write-Host "    Certificate exported to $certPath"

Write-Host "2/5 Trusting the certificate machine-wide (Root + Trusted Publishers)..."
Import-Certificate -FilePath $certPath -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Import-Certificate -FilePath $certPath -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null

Write-Host "3/5 Generating the driver catalog file..."
& (Join-Path $sdkBin "Inf2Cat.exe") /driver:$packageDir /os:10_X64
if ($LASTEXITCODE -ne 0) {
    throw "Inf2Cat failed with exit code $LASTEXITCODE"
}

Write-Host "4/5 Signing the catalog with the test certificate..."
$catPath = Join-Path $packageDir "YomagAudioDriver.cat"
& (Join-Path $sdkBin "signtool.exe") sign /v /s My /n "YomagAudio Test Certificate" /fd SHA256 $catPath
if ($LASTEXITCODE -ne 0) {
    throw "signtool failed with exit code $LASTEXITCODE"
}

Write-Host "5/5 Enabling Windows test-signing mode..."
bcdedit /set testsigning on

Write-Host ""
Write-Host "Done. REBOOT NOW, then run install-driver-step2.ps1 (also as Administrator) to install the driver."
