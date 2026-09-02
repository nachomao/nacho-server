param([switch]$Purge)
$ErrorActionPreference = 'Stop'
$ServerUrl = '__NACHO_BASE_URL__'
$ServiceName = 'NachoAgent'
$VendorDir = Join-Path $env:ProgramFiles 'Nacho'
$InstallDir = Join-Path $env:ProgramFiles 'Nacho\Agent'
$DataDir = Join-Path $env:ProgramData 'Nacho'
$HistoricalBackupDir = Join-Path $env:ProgramFiles 'NachoAgentBackups'
$AgentPath = Join-Path $InstallDir 'nacho-agent.exe'

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
  if ($Purge) {
    $elevatedCommand = "& { & ([scriptblock]::Create((irm '$ServerUrl/uninstall.ps1'))) -Purge }"
  } else {
    $elevatedCommand = "& { irm '$ServerUrl/uninstall.ps1' | iex }"
  }
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($elevatedCommand))
  $elevated = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
  exit $elevated.ExitCode
}

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Stop-Service -Name $ServiceName -Force -ErrorAction Stop
  $service = Get-Service -Name $ServiceName -ErrorAction Stop
  $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
  $service.Dispose()
}
if ((Test-Path $AgentPath) -and (Test-Path (Join-Path $DataDir 'agent.json')) -and (Test-Path (Join-Path $DataDir 'state.dat'))) {
  $unregisterArgument = if ($Purge) { '--unregister' } else { '--mark-unregistered' }
  $unregister = Start-Process -FilePath $AgentPath -ArgumentList $unregisterArgument -PassThru -WindowStyle Hidden
  if (-not $unregister.WaitForExit(30000)) {
    Stop-Process -Id $unregister.Id -Force -ErrorAction SilentlyContinue
    throw 'Server client status update timed out; local data was preserved for retry.'
  }
  if ($unregister.ExitCode -ne 0) {
    throw "Server client status update failed (exit $($unregister.ExitCode)); local data was preserved for retry."
  }
}
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  $deleteOutput = & sc.exe delete $ServiceName 2>&1
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1060) {
    throw "Failed to delete Windows service (sc.exe exit $LASTEXITCODE): $deleteOutput"
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ((Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    throw "Windows service '$ServiceName' is still registered after deletion."
  }
}
if (Test-Path $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
if ($Purge) {
  foreach ($path in @($DataDir, $HistoricalBackupDir)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
  }
  if ((Test-Path -LiteralPath $VendorDir) -and -not (Get-ChildItem -LiteralPath $VendorDir -Force | Select-Object -First 1)) {
    Remove-Item -LiteralPath $VendorDir -Force
  }
}

$residue = @()
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { $residue += "service:$ServiceName" }
if (Test-Path -LiteralPath $InstallDir) { $residue += $InstallDir }
if ($Purge) {
  foreach ($path in @($DataDir, $HistoricalBackupDir)) {
    if (Test-Path -LiteralPath $path) { $residue += $path }
  }
  if ((Test-Path -LiteralPath $VendorDir) -and -not (Get-ChildItem -LiteralPath $VendorDir -Force | Select-Object -First 1)) {
    $residue += $VendorDir
  }
}
if ($residue.Count -gt 0) { throw "Nacho Agent uninstall left residue: $($residue -join ', ')" }

Write-Host $(if ($Purge) { 'Nacho Agent removed with no managed local data remaining.' } else { 'Nacho Agent removed; data preserved.' })
