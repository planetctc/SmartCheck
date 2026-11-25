# Builds sensors/ (LibreHardwareMonitorLib reader) into sensors/out for the installer.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
dotnet publish "$root\sensors\SmartDiskSensors.csproj" -c Release -o "$root\sensors\out"
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed ($LASTEXITCODE)" }
if (-not (Test-Path "$root\sensors\out\smartdisk-sensors.exe")) { throw "smartdisk-sensors.exe missing" }
Get-ChildItem "$root\sensors\out" | Select-Object Name, Length | Format-Table -AutoSize
