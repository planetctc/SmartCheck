# Builds Microsoft DiskSpd (MIT License, https://github.com/microsoft/diskspd) from source at a pinned tag.
# The prebuilt release binaries carry a different licence, so smartDisk ships its own build of the MIT source.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'third_party\diskspd'
$tag = 'v2.2'
if (-not (Test-Path (Join-Path $dir '.git'))) {
  git clone --depth 1 --branch $tag https://github.com/microsoft/diskspd.git $dir
}
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$msbuild = & $vswhere -latest -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
if (-not $msbuild) { throw 'MSBuild not found' }
$props = Join-Path $PSScriptRoot 'static-crt.props'
& $msbuild (Join-Path $dir 'diskspd_vs\diskspd.sln') /m /nologo /v:minimal `
  /p:Configuration=Release /p:Platform=x64 "/p:ForceImportBeforeCppTargets=$props"
if ($LASTEXITCODE -ne 0) { throw "DiskSpd build failed ($LASTEXITCODE)" }
$exe = Join-Path $dir 'diskspd_vs\x64\Release\diskspd.exe'
if (-not (Test-Path $exe)) { throw "diskspd.exe not found at $exe" }
Write-Host "DiskSpd built: $exe"
