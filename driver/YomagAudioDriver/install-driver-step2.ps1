# YomagAudioDriver test-signing setup - STEP 2 of 2
#
# Run this in an ELEVATED PowerShell window AFTER rebooting from step 1.
#
# Installs the driver package into the Windows driver store and registers
# it for hardware ID Root\YomagAudioCable, so that YomagAudio's "Create
# System Endpoint" (which uses SwDeviceCreate to instantiate device nodes
# matching that hardware ID) can bind a real, working audio driver to each
# one instead of a driverless device node.

$ErrorActionPreference = "Stop"

$infPath = Join-Path $PSScriptRoot "x64\Debug\YomagAudioDriver.inf"
if (-not (Test-Path $infPath)) {
    throw "Expected $infPath - did install-driver-step1.ps1 run successfully first?"
}

Write-Host "Installing driver package from $infPath ..."
pnputil /add-driver $infPath /install
if ($LASTEXITCODE -ne 0) {
    throw "pnputil failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "Driver installed. In YomagAudio, click 'Create System Endpoint' again -"
Write-Host "it should now appear as a real device in other apps' input/output lists."
