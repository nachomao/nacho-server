param(
  [string]$RunMode,
  [string]$EnrollmentKey,
  [string]$ClientAction
)

$ErrorActionPreference = 'Stop'
$ArtifactBaseUrl = __NACHO_ARTIFACT_BASE_URL__
$AgentServerUrl = __NACHO_AGENT_SERVER_URL__
$InstallScriptUrl = __NACHO_INSTALL_SCRIPT_URL__
$OpenEnrollment = __NACHO_OPEN_ENROLLMENT__
$ProfileId = __NACHO_PROFILE_ID__
$ProfileRevision = __NACHO_PROFILE_REVISION__
$ProfileRunMode = __NACHO_PROFILE_RUN_MODE__
$ProfileHeartbeatSeconds = __NACHO_PROFILE_HEARTBEAT_SECONDS__
$ProfilePollSeconds = __NACHO_PROFILE_POLL_SECONDS__
$ProfileClientName = __NACHO_PROFILE_CLIENT_NAME__
$ProfileGroup = __NACHO_PROFILE_GROUP__
$ProfileTags = __NACHO_PROFILE_TAGS__
$ProfileOverwriteExisting = __NACHO_PROFILE_OVERWRITE_EXISTING__
$ProfileReEnrollOnServerChange = __NACHO_PROFILE_REENROLL__

$ServiceName = 'NachoAgent'
$InstallDir = Join-Path $env:ProgramFiles 'Nacho\Agent'
$DataDir = Join-Path $env:ProgramData 'Nacho'
$LogFile = Join-Path $DataDir 'install.log'
$agentPath = Join-Path $InstallDir 'nacho-agent.exe'
$configPath = Join-Path $DataDir 'agent.json'
$stateFile = Join-Path $DataDir 'state.dat'

if (-not [string]::IsNullOrWhiteSpace($RunMode) -and $RunMode -notin @('menu', 'silent')) {
  throw "RunMode must be 'menu' or 'silent'."
}

$effectiveRunMode = $RunMode
if ([string]::IsNullOrWhiteSpace($effectiveRunMode) -and $env:NACHO_INSTALL_MODE -in @('menu', 'silent')) {
  $effectiveRunMode = $env:NACHO_INSTALL_MODE
}
if ([string]::IsNullOrWhiteSpace($effectiveRunMode)) { $effectiveRunMode = $ProfileRunMode }
$silent = $effectiveRunMode -eq 'silent'
if ($silent) { $ProgressPreference = 'SilentlyContinue' }

if (-not [string]::IsNullOrWhiteSpace($ClientAction) -and $ClientAction -notin @('install', 'uninstall', 'purge')) {
  throw "ClientAction must be install, uninstall, or purge."
}

if ([string]::IsNullOrWhiteSpace($ClientAction)) {
  if ($silent) {
    $ClientAction = 'install'
  } else {
    Write-Host ''
    Write-Host 'Nacho Agent client menu' -ForegroundColor Cyan
    Write-Host '1. Install / upgrade client'
    Write-Host '2. Uninstall client (keep data)'
    Write-Host '3. Uninstall client and purge all data'
    Write-Host '4. Exit'
    $selection = Read-Host 'Select an action'
    switch ($selection) {
      '1' { $ClientAction = 'install' }
      '2' { $ClientAction = 'uninstall' }
      '3' { $ClientAction = 'purge' }
      '4' { Write-Host 'Exited.'; return }
      '' { $ClientAction = 'install' }
      default { throw 'Invalid menu selection.' }
    }
  }
}

if ($ClientAction -in @('uninstall', 'purge')) {
  $uninstallScript = Invoke-RestMethod -Uri "$ArtifactBaseUrl/uninstall.ps1" -UseBasicParsing
  $uninstallBlock = [scriptblock]::Create($uninstallScript)
  if ($ClientAction -eq 'purge') { & $uninstallBlock -Purge } else { & $uninstallBlock }
  return
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Set-ConfigProperty($target, [string]$name, $value) {
  if ($target.PSObject.Properties.Name -contains $name) { $target.$name = $value }
  else { $target | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}

function Normalize-ServerUrl([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return '' }
  return $value.Trim().TrimEnd('/').ToLowerInvariant()
}

if (-not (Test-Administrator)) {
  $actionLiteral = $ClientAction.Replace("'", "''")
  $scriptLiteral = $InstallScriptUrl.Replace("'", "''")
  $keyForElevation = $EnrollmentKey
  if ([string]::IsNullOrWhiteSpace($keyForElevation)) { $keyForElevation = $env:NACHO_ENROLLMENT_KEY }
  $keyLiteral = ([string]$keyForElevation).Replace("'", "''")
  $elevatedScriptUrl = "$scriptLiteral&elevated=1"
  $elevatedCommand = "& { `$script = [scriptblock]::Create((irm '$elevatedScriptUrl')); & `$script -RunMode 'silent' -ClientAction '$actionLiteral' -EnrollmentKey '$keyLiteral' }"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($elevatedCommand))
  $elevated = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
  if ($elevated.ExitCode -ne 0) {
    throw "Nacho Agent installation failed in the elevated process (exit $($elevated.ExitCode)). Review $LogFile from an elevated PowerShell window."
  }
  return
}

New-Item -ItemType Directory -Force -Path $DataDir, $InstallDir | Out-Null
& icacls.exe $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to secure Agent data directory (icacls exit $LASTEXITCODE)." }
Start-Transcript -Path $LogFile -Append -Force | Out-Null

$temporary = Join-Path $env:TEMP ("nacho-agent-" + [Guid]::NewGuid().ToString('N') + '.exe')
$agentBackup = Join-Path $env:TEMP ("nacho-agent-backup-" + [Guid]::NewGuid().ToString('N') + '.exe')
$configBackup = Join-Path $env:TEMP ("nacho-config-backup-" + [Guid]::NewGuid().ToString('N') + '.json')
$stateBackup = Join-Path $env:TEMP ("nacho-state-backup-" + [Guid]::NewGuid().ToString('N') + '.dat')
$existingService = $null
$serviceWasRunning = $false
$serviceCreated = $false
$agentBackedUp = $false
$configBackedUp = $false
$stateBackedUp = $false
$enrollmentKeyWritten = $false

try {
  $manifest = Invoke-RestMethod -Uri "$ArtifactBaseUrl/agent/downloads/windows/latest.json" -UseBasicParsing
  if (-not $manifest.fileName -or -not $manifest.sha256) { throw 'Invalid Agent manifest.' }
  if ($manifest.fileName -notmatch '^[a-zA-Z0-9._-]+$') { throw 'Invalid Agent artifact name.' }

  $existingConfig = $null
  $serverChanged = $false
  if (Test-Path $configPath) {
    Copy-Item -LiteralPath $configPath -Destination $configBackup -Force
    $configBackedUp = $true
    $existingConfig = Get-Content -Raw -Encoding UTF8 $configPath | ConvertFrom-Json
    $serverChanged = (Normalize-ServerUrl ([string]$existingConfig.serverUrl)) -ne (Normalize-ServerUrl $AgentServerUrl)
  }
  $reEnroll = $ProfileReEnrollOnServerChange -and $serverChanged -and (Test-Path $stateFile)
  $needsEnrollment = $reEnroll -or -not (Test-Path $stateFile)

  if ($needsEnrollment -and -not $OpenEnrollment) {
    $enrollmentKey = $EnrollmentKey
    if ([string]::IsNullOrWhiteSpace($enrollmentKey)) { $enrollmentKey = $env:NACHO_ENROLLMENT_KEY }
    if ([string]::IsNullOrWhiteSpace($enrollmentKey) -and -not $silent) {
      $secure = Read-Host 'Enrollment key' -AsSecureString
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try { $enrollmentKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
      finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    if ([string]::IsNullOrWhiteSpace($enrollmentKey)) {
      throw 'NACHO_ENROLLMENT_KEY is required because open enrollment is disabled.'
    }
    [IO.File]::WriteAllText((Join-Path $DataDir 'enrollment.key'), $enrollmentKey, [Text.UTF8Encoding]::new($false))
    $enrollmentKeyWritten = $true
    Remove-Variable enrollmentKey -ErrorAction SilentlyContinue
  }

  Invoke-WebRequest -Uri "$ArtifactBaseUrl/agent/downloads/windows/$($manifest.fileName)" -OutFile $temporary -UseBasicParsing
  $actual = (Get-FileHash -Path $temporary -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $manifest.sha256.ToLowerInvariant()) { throw 'Agent checksum verification failed.' }

  if ($existingConfig) {
    $config = $existingConfig
    Set-ConfigProperty $config 'serverUrl' $AgentServerUrl
    if ($ProfileOverwriteExisting) {
      Set-ConfigProperty $config 'name' $(if ($ProfileClientName) { $ProfileClientName } else { $env:COMPUTERNAME })
      Set-ConfigProperty $config 'group' $ProfileGroup
      Set-ConfigProperty $config 'tags' @($ProfileTags)
      Set-ConfigProperty $config 'heartbeatSeconds' $ProfileHeartbeatSeconds
      Set-ConfigProperty $config 'pollSeconds' $ProfilePollSeconds
    }
    Set-ConfigProperty $config 'disableAllPolicies' $true
    Set-ConfigProperty $config 'allowMessagePush' $true
    foreach ($legacyOpenUrlPolicyField in @('allowOpenUrl', 'allowedUrlSchemes', 'allowedUrlHosts')) {
      $config.PSObject.Properties.Remove($legacyOpenUrlPolicyField)
    }
  } else {
    $config = [ordered]@{
      serverUrl = $AgentServerUrl
      name = $(if ($ProfileClientName) { $ProfileClientName } else { $env:COMPUTERNAME })
      group = $ProfileGroup
      tags = @($ProfileTags)
      heartbeatSeconds = $ProfileHeartbeatSeconds
      pollSeconds = $ProfilePollSeconds
      defaultExecutionSeconds = 300
      maxExecutionSeconds = 900
      maxOutputBytes = 1048576
      disableAllPolicies = $true
      outputCodePage = 0
      allowCmdExecution = $false
      allowPowerShellExecution = $false
      allowPackageInstall = $false
      allowLocalUserManagement = $false
      allowedLocalUsers = @()
      allowedLocalGroups = @()
      allowedRegistryPaths = @()
      allowMessagePush = $true
      allowedDeployRoots = @()
      fileDeployBackupRetentionDays = 7
      allowSystemRestart = $false
      allowLogCollection = $false
      updateBackupRetentionCount = 2
      updateBackupMaxBytes = 1073741824
      allowedServices = @()
      allowedProcessPaths = @()
      allowedPrograms = @(
        (Join-Path $env:WINDIR 'System32\hostname.exe'),
        (Join-Path $env:WINDIR 'System32\whoami.exe'),
        (Join-Path $env:WINDIR 'System32\ipconfig.exe')
      )
    }
  }
  [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))

  $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($existingService) {
    $serviceWasRunning = $existingService.Status -eq 'Running'
    $serviceProcessId = (Get-CimInstance Win32_Service -Filter "Name='$ServiceName'").ProcessId
    if ($existingService.Status -ne 'Stopped') {
      Stop-Service -Name $ServiceName -Force -ErrorAction Stop
      $stoppedStatus = [Enum]::Parse($existingService.Status.GetType(), 'Stopped')
      $existingService.WaitForStatus($stoppedStatus, [TimeSpan]::FromSeconds(30))
    }
    if ($serviceProcessId -gt 0) { Wait-Process -Id $serviceProcessId -Timeout 30 -ErrorAction SilentlyContinue }
  }

  if ($reEnroll) {
    Copy-Item -LiteralPath $stateFile -Destination $stateBackup -Force
    $stateBackedUp = $true
    Remove-Item -LiteralPath $stateFile -Force
  }
  if (Test-Path $agentPath) {
    Copy-Item -LiteralPath $agentPath -Destination $agentBackup -Force
    $agentBackedUp = $true
  }

  $copyCompleted = $false
  $copyFailure = $null
  for ($attempt = 1; $attempt -le 30; $attempt++) {
    try {
      [IO.File]::Copy($temporary, $agentPath, $true)
      $copyCompleted = $true
      break
    } catch [IO.IOException] {
      $copyFailure = $_.Exception
      Start-Sleep -Seconds 1
    } catch [System.UnauthorizedAccessException] {
      $copyFailure = $_.Exception
      Start-Sleep -Seconds 1
    }
  }
  if (-not $copyCompleted) { throw "Agent executable could not be replaced after 30 attempts: $($copyFailure.Message)" }
  $installedHash = (Get-FileHash -Path $agentPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($installedHash -ne $manifest.sha256.ToLowerInvariant()) { throw 'Installed Agent checksum verification failed.' }

  if ($existingService) {
    & sc.exe config $ServiceName binPath= "`"$agentPath`"" start= delayed-auto obj= LocalSystem | Out-Null
  } else {
    & sc.exe create $ServiceName binPath= "`"$agentPath`"" start= delayed-auto obj= LocalSystem | Out-Null
    $serviceCreated = $LASTEXITCODE -eq 0
  }
  if ($LASTEXITCODE -ne 0) { throw "Failed to create or configure service (sc.exe exit $LASTEXITCODE)." }
  & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to configure service recovery (sc.exe exit $LASTEXITCODE)." }
  Start-Service -Name $ServiceName
  $runningService = Get-Service -Name $ServiceName -ErrorAction Stop
  $runningStatus = [Enum]::Parse($runningService.Status.GetType(), 'Running')
  $runningService.WaitForStatus($runningStatus, [TimeSpan]::FromSeconds(30))

  if ($needsEnrollment) {
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while (-not (Test-Path $stateFile) -and [DateTime]::UtcNow -lt $deadline) {
      $service = Get-Service -Name $ServiceName -ErrorAction Stop
      if ($service.Status -ne 'Running') { throw "NachoAgent stopped before enrollment completed (status: $($service.Status))." }
      Start-Sleep -Seconds 1
    }
    if (-not (Test-Path $stateFile)) { throw 'NachoAgent started, but device enrollment did not complete within 45 seconds.' }
  }

  Write-Host "Nacho Agent $($manifest.version) installed and started (profile $ProfileId revision $ProfileRevision)."
} catch {
  try {
    $currentService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($currentService -and $currentService.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue }
    if ($agentBackedUp -and (Test-Path $agentBackup)) { Copy-Item -LiteralPath $agentBackup -Destination $agentPath -Force }
    if ($configBackedUp -and (Test-Path $configBackup)) { Copy-Item -LiteralPath $configBackup -Destination $configPath -Force }
    elseif (-not $configBackedUp -and (Test-Path $configPath)) { Remove-Item -LiteralPath $configPath -Force }
    if ($stateBackedUp -and (Test-Path $stateBackup)) { Copy-Item -LiteralPath $stateBackup -Destination $stateFile -Force }
    if ($enrollmentKeyWritten -and (Test-Path (Join-Path $DataDir 'enrollment.key'))) { Remove-Item -LiteralPath (Join-Path $DataDir 'enrollment.key') -Force }
    if ($serviceCreated) { & sc.exe delete $ServiceName | Out-Null }
    elseif ($existingService -and $serviceWasRunning -and (Test-Path $agentPath)) { Start-Service -Name $ServiceName -ErrorAction Stop }
  } catch {
    Write-Warning "Failed to restore the previous Agent state: $($_.Exception.Message)"
  }
  Write-Error "Nacho Agent installation failed: $($_.Exception.Message)`nLog: $LogFile"
  if (-not $silent -and $env:NACHO_INSTALL_NO_PAUSE -ne '1' -and [Environment]::UserInteractive) {
    Read-Host 'Press Enter to close this elevated installer window'
  }
  throw
} finally {
  foreach ($path in @($temporary, $agentBackup, $configBackup, $stateBackup)) {
    if (Test-Path $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  }
  Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}

