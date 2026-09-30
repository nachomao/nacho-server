param([string]$Output = "")
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $Output) { $Output = Join-Path $root "artifacts\releases" }
$manifest = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json
if ($manifest.version -notmatch '^\d+\.\d+\.\d+$') { throw "服务端版本必须为 x.y.z" }
$stage = Join-Path ([IO.Path]::GetTempPath()) ("nacho-server-win-release-" + [guid]::NewGuid().ToString("N"))
try {
  Push-Location $root
  try {
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci 失败" }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build 失败" }
  } finally { Pop-Location }
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  foreach ($file in @("dist", "package.json", "package-lock.json", "deploy")) {
    Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $stage $file) -Recurse -Force
  }
  Push-Location $stage
  try {
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "生产依赖安装失败" }
  } finally { Pop-Location }
  New-Item -ItemType Directory -Path $Output -Force | Out-Null
  $zip = Join-Path $Output "control-server-$($manifest.version)-win-x64.zip"
  Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal -Force
  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Output "Windows 服务端制品：$zip SHA-256=$hash"
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
