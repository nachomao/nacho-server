param([switch]$Purge)
$ErrorActionPreference = 'Stop'
$ServerUrl = '__NACHO_BASE_URL__'
$ServiceName = 'NachoAgent'
$InstallDir = Join-Path $env:ProgramFiles 'Nacho\Agent'
$DataDir = Join-Path $env:ProgramData 'Nacho'

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("& { irm '$ServerUrl/uninstall.ps1' | iex }"))
  Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
  exit $LASTEXITCODE
}

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  & sc.exe delete $ServiceName | Out-Null
}
if (Test-Path $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
if ($Purge -and (Test-Path $DataDir)) { Remove-Item -LiteralPath $DataDir -Recurse -Force }
Write-Host 'Nacho Agent removed.'
