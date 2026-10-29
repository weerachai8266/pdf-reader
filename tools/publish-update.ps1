# Uploads the installer built by `npm run dist` to the update server.
#
# Order matters: the installer and its .blockmap go up first, latest.yml
# last, so no PC sees the new version before its installer is complete.
# Every file is uploaded under a .part name and renamed on the server, so a
# half-uploaded file is never served. Old installers beyond -Keep are
# deleted; old .blockmap files stay (they are small, and differential
# downloads from older versions need them).

param(
    [string]$Server = 'weerachai@192.168.0.44',
    [string]$RemoteDir = '/var/www/html/pdf-reader',
    [string]$PublicUrl = 'http://192.168.0.44/pdf-reader/',
    [int]$Keep = 3
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content "$root\package.json" -Raw | ConvertFrom-Json).version
$exe = "$root\dist\PDF-Reader-Setup-$version.exe"
$blockmap = "$exe.blockmap"
$latest = "$root\dist\latest.yml"

foreach ($f in @($exe, $blockmap, $latest)) {
    if (-not (Test-Path $f)) { throw "Missing $f - run npm run dist first" }
}
if ((Get-Content $latest -Raw) -notmatch "(?m)^version: $([regex]::Escape($version))\s*$") {
    throw "dist\latest.yml is not for version $version - run npm run dist again"
}

function Invoke-Remote([string]$cmd) {
    ssh -o BatchMode=yes $Server $cmd
    if ($LASTEXITCODE -ne 0) { throw "ssh failed: $cmd" }
}

function Send-File([string]$local) {
    $name = Split-Path $local -Leaf
    Write-Host "upload $name ($([math]::Round((Get-Item $local).Length / 1MB, 1)) MB)"
    scp -o BatchMode=yes -q $local "${Server}:$RemoteDir/$name.part"
    if ($LASTEXITCODE -ne 0) { throw "scp failed: $name" }
    Invoke-Remote "mv -f '$RemoteDir/$name.part' '$RemoteDir/$name'"
}

Invoke-Remote "mkdir -p '$RemoteDir'"
Send-File $exe
Send-File $blockmap
Send-File $latest

# Keep the newest $Keep installers.
Invoke-Remote "cd '$RemoteDir' && ls -1t PDF-Reader-Setup-*.exe | tail -n +$($Keep + 1) | xargs -r rm -f"

# Check what the PCs will see.
$served = (Invoke-WebRequest "${PublicUrl}latest.yml" -UseBasicParsing -Headers @{ 'Cache-Control' = 'no-cache' }).Content
if ($served -is [byte[]]) { $served = [Text.Encoding]::UTF8.GetString($served) }
if ($served -notmatch "(?m)^version: $([regex]::Escape($version))\s*$") { throw "Server latest.yml does not show $version" }
$head = Invoke-WebRequest "${PublicUrl}PDF-Reader-Setup-$version.exe" -Method Head -UseBasicParsing
if ([int64]$head.Headers['Content-Length'] -ne (Get-Item $exe).Length) { throw 'Installer size on the server does not match' }

Write-Host "published v$version -> $PublicUrl"
Invoke-Remote "ls -l '$RemoteDir'"
