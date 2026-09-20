param(
  [ValidateSet("Debug", "Release")]
  [string]$Configuration = "Release",
  [string]$Runtime = "win-x64"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$project = Join-Path $repo "desktop\src\ContE.Desktop\ContE.Desktop.csproj"
$setupProject = Join-Path $repo "desktop\setup\ContE.Setup.csproj"
$publish = Join-Path $repo "artifacts\desktop\$Runtime"
$setupPublish = Join-Path $repo "artifacts\setup\$Runtime"
$archive = Join-Path $repo "artifacts\contE-$Runtime.zip"
$setup = Join-Path $repo "artifacts\contE-Setup-$Runtime.exe"

Push-Location $repo
try {
  npm run test
  npm run build
  dotnet restore $project
  dotnet restore $setupProject

  $desktopPublishArgs = @(
    "--configuration", $Configuration,
    "--runtime", $Runtime,
    "--self-contained", "true",
    "--output", $publish,
    "-p:PublishSingleFile=true",
    "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-p:DebugType=None"
  )
  dotnet publish $project @desktopPublishArgs

  if (Test-Path $archive) { Remove-Item $archive -Force }
  Compress-Archive -Path (Join-Path $publish "*") -DestinationPath $archive

  if (Test-Path $setupPublish) { Remove-Item $setupPublish -Recurse -Force }
  $setupPublishArgs = @(
    "--configuration", $Configuration,
    "--runtime", $Runtime,
    "--self-contained", "true",
    "--output", $setupPublish,
    "-p:PayloadZip=$archive",
    "-p:PublishSingleFile=true",
    "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-p:DebugType=None"
  )
  dotnet publish $setupProject @setupPublishArgs

  if (Test-Path $setup) { Remove-Item $setup -Force }
  Move-Item (Join-Path $setupPublish "contE-Setup.exe") $setup

  Get-FileHash $archive -Algorithm SHA256 | Format-List
  Get-FileHash $setup -Algorithm SHA256 | Format-List
  Write-Host "Created $archive"
  Write-Host "Created $setup"
}
finally {
  Pop-Location
}
