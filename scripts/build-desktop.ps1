param(
  [ValidateSet("Debug", "Release")]
  [string]$Configuration = "Release",
  [string]$Runtime = "win-x64"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$project = Join-Path $repo "desktop\src\ContE.Desktop\ContE.Desktop.csproj"
$publish = Join-Path $repo "artifacts\desktop\$Runtime"
$archive = Join-Path $repo "artifacts\contE-$Runtime.zip"

Push-Location $repo
try {
  npm run test
  npm run build
  dotnet restore $project
  dotnet publish $project `
    --configuration $Configuration `
    --runtime $Runtime `
    --self-contained true `
    --output $publish `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:DebugType=None

  if (Test-Path $archive) { Remove-Item $archive -Force }
  Compress-Archive -Path (Join-Path $publish "*") -DestinationPath $archive
  Get-FileHash $archive -Algorithm SHA256 | Format-List
  Write-Host "Created $archive"
}
finally {
  Pop-Location
}
