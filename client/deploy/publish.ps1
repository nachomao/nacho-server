param(
  [string]$ArtifactsPath = (Join-Path $PSScriptRoot '..\..\artifacts\windows')
)
$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot '..\src\Nacho.Agent\Nacho.Agent.csproj'
$publish = Join-Path $env:TEMP ('nacho-publish-' + [Guid]::NewGuid().ToString('N'))
try {
  dotnet publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $publish
  if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed.' }
  $version = (dotnet msbuild $project -getProperty:Version -nologo).Trim()
  $name = "nacho-agent-$version-win-x64.exe"
  New-Item -ItemType Directory -Force -Path $ArtifactsPath | Out-Null
  Copy-Item (Join-Path $publish 'nacho-agent.exe') (Join-Path $ArtifactsPath $name) -Force
  $hash = (Get-FileHash (Join-Path $ArtifactsPath $name) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw "Version '$version' is not strict x.y.z." }
  $artifact = Get-Item -LiteralPath (Join-Path $ArtifactsPath $name)
  $actualHash = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $hash) { throw 'Published artifact hash verification failed.' }
  $manifest = @{ version = $version; fileName = $name; sha256 = $actualHash; rid = 'win-x64'; sizeBytes = $artifact.Length; publishedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $ArtifactsPath 'latest.json'), $manifest, [Text.UTF8Encoding]::new($false))
  Write-Host "Published $name to $ArtifactsPath"
}
finally {
  if (Test-Path $publish) { Remove-Item -LiteralPath $publish -Recurse -Force }
}
