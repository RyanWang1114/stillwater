$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectDirectory 'package.json') -Raw | ConvertFrom-Json
$portable = Join-Path $projectDirectory ("release\Stillwater-" + $manifest.version + "-Windows-x64.exe")
$unpacked = Join-Path $projectDirectory 'release\win-unpacked\Stillwater.exe'
if (Test-Path -LiteralPath $portable -PathType Leaf) {
    Start-Process -FilePath $portable
} elseif (Test-Path -LiteralPath $unpacked -PathType Leaf) {
    Start-Process -FilePath $unpacked
} else {
    Write-Error 'The desktop app has not been built. Open the downloaded Stillwater .exe, or run pnpm install and pnpm run build:win in this source folder.'
    exit 1
}
