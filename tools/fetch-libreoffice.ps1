# Downloads LibreOffice, checks its SHA-256, and unpacks it (no system
# install) into vendor/libreoffice, where electron-builder picks it up for
# the installer. Parts a headless converter never uses are removed to keep
# the installer smaller. Run once per machine that builds the installer:
#   powershell -ExecutionPolicy Bypass -File tools\fetch-libreoffice.ps1

$ErrorActionPreference = 'Stop'

$Version = '26.2.6'
$Sha256 = 'f9877032fd908beb9c0ddf06df4af5c2e85f419c42e14876c4cce5aae5fb2660'
$Url = "https://download.documentfoundation.org/libreoffice/stable/$Version/win/x86_64/LibreOffice_${Version}_Win_x86-64.msi"

$Root = Split-Path -Parent $PSScriptRoot
$Cache = Join-Path $Root 'vendor\cache'
$Msi = Join-Path $Cache "LibreOffice_${Version}_Win_x86-64.msi"
$Target = Join-Path $Root 'vendor\libreoffice'
$Staging = Join-Path $Cache 'lo-admin'

New-Item -ItemType Directory -Force $Cache | Out-Null

if (-not (Test-Path $Msi) -or (Get-FileHash $Msi -Algorithm SHA256).Hash -ne $Sha256.ToUpper()) {
    Write-Host "Downloading LibreOffice $Version ..."
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $Url -OutFile $Msi -UseBasicParsing
}
$hash = (Get-FileHash $Msi -Algorithm SHA256).Hash
if ($hash -ne $Sha256.ToUpper()) { throw "SHA-256 mismatch for $Msi ($hash)" }

Write-Host 'Unpacking (administrative install, nothing is installed on this PC) ...'
if (Test-Path $Staging) { Remove-Item -Recurse -Force $Staging }
$p = Start-Process msiexec.exe -ArgumentList @('/a', "`"$Msi`"", '/qn', "TARGETDIR=`"$Staging`"") -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "msiexec /a failed with exit code $($p.ExitCode)" }

# The administrative image is the program tree itself, plus the fonts and
# VC++ runtime the MSI would install system-wide (System64 = x64 DLLs).
if (-not (Test-Path (Join-Path $Staging 'program\soffice.exe'))) { throw 'soffice.exe not found after unpacking' }
# App-local VC++ runtime, so PCs without the redistributable still work.
Copy-Item (Join-Path $Staging 'System64\*.dll') (Join-Path $Staging 'program') -Force

# Not needed for converting documents from the command line: spelling
# dictionaries, UI translations, icon themes other than the default, help,
# templates and galleries. (Python must stay: LibreOffice loads it while
# creating its profile and aborts without it.)
$drop = @(
    'System',
    'System64',
    'Fonts',
    '*.msi',
    'help',
    'readmes',
    'share\gallery',
    'share\template',
    'share\wizards',
    'share\autotext',
    'share\extensions\*',
    'program\resource\*',
    'program\classes'
)
foreach ($rel in $drop) {
    Get-ChildItem -Path (Join-Path $Staging $rel) -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item -Recurse -Force $_.FullName
    }
}
Get-ChildItem -Path (Join-Path $Staging 'share\config') -Filter 'images_*.zip' |
    Where-Object { $_.Name -ne 'images_colibre.zip' } | Remove-Item -Force
Get-ChildItem -Path (Join-Path $Staging 'share\registry\res') -Filter 'registry_*.xcd' |
    Where-Object { $_.Name -ne 'registry_en-US.xcd' } | Remove-Item -Force

if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
Move-Item $Staging $Target
Set-Content -Path (Join-Path $Target 'VERSION.txt') -Value $Version -Encoding ascii

$size = (Get-ChildItem $Target -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("LibreOffice $Version ready in vendor\libreoffice ({0:N0} MB)" -f $size)
