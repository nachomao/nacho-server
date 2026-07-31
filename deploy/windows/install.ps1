$ErrorActionPreference = 'Stop'
$ServerUrl = '__NACHO_BASE_URL__'
$OpenEnrollment = __NACHO_OPEN_ENROLLMENT__
$ServiceName = 'NachoAgent'
$InstallDir = Join-Path $env:ProgramFiles 'Nacho\Agent'
$DataDir = Join-Path $env:ProgramData 'Nacho'
$LogFile = Join-Path $DataDir 'install.log'

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("& { irm '$ServerUrl/install.ps1' | iex }"))
  $elevated = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
  if ($elevated.ExitCode -ne 0) {
    throw "Nacho Agent installation failed in the elevated process (exit $($elevated.ExitCode)). Review $LogFile from an elevated PowerShell window."
  }
  return
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Start-Transcript -Path $LogFile -Append -Force | Out-Null
$serviceStoppedForUpgrade = $false
$serviceWasRunning = $false
$agentPath = Join-Path $InstallDir 'nacho-agent.exe'

try {
  $manifest = Invoke-RestMethod -Uri "$ServerUrl/agent/downloads/windows/latest.json" -UseBasicParsing
  if (-not $manifest.fileName -or -not $manifest.sha256) { throw 'Invalid Agent manifest.' }
  if ($manifest.fileName -notmatch '^[a-zA-Z0-9._-]+$') { throw 'Invalid Agent artifact name.' }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $stateFile = Join-Path $DataDir 'state.dat'
  if (-not $OpenEnrollment -and -not (Test-Path $stateFile)) {
    $enrollmentKey = $env:NACHO_ENROLLMENT_KEY
    if ([string]::IsNullOrWhiteSpace($enrollmentKey)) {
      $secure = Read-Host 'Enrollment key' -AsSecureString
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try { $enrollmentKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
      finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    if ([string]::IsNullOrWhiteSpace($enrollmentKey)) {
      throw 'Enrollment key is required because open enrollment is disabled.'
    }
    [IO.File]::WriteAllText((Join-Path $DataDir 'enrollment.key'), $enrollmentKey, [Text.UTF8Encoding]::new($false))
    Remove-Variable enrollmentKey -ErrorAction SilentlyContinue
  }

  $temporary = Join-Path $env:TEMP ("nacho-agent-" + [Guid]::NewGuid().ToString('N') + '.exe')
  try {
    Invoke-WebRequest -Uri "$ServerUrl/agent/downloads/windows/$($manifest.fileName)" -OutFile $temporary -UseBasicParsing
    $actual = (Get-FileHash -Path $temporary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $manifest.sha256.ToLowerInvariant()) { throw 'Agent checksum verification failed.' }
    $configPath = Join-Path $DataDir 'agent.json'
    if (Test-Path $configPath) {
      $config = Get-Content -Raw -Encoding UTF8 $configPath | ConvertFrom-Json
      $config.serverUrl = $ServerUrl
    } else {
      $config = [ordered]@{
        serverUrl = $ServerUrl
        name = $env:COMPUTERNAME
        group = '默认分组'
        tags = @()
        heartbeatSeconds = 20
        pollSeconds = 15
        defaultExecutionSeconds = 300
        maxExecutionSeconds = 900
        maxOutputBytes = 1048576
        outputCodePage = 0
        allowSystemRestart = $false
        allowLogCollection = $false
        allowedServices = @()
        allowedProcessPaths = @()
        allowedPrograms = @(
          (Join-Path $env:WINDIR 'System32\hostname.exe'),
          (Join-Path $env:WINDIR 'System32\whoami.exe'),
          (Join-Path $env:WINDIR 'System32\ipconfig.exe')
        )
      }
    }
    [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
      $serviceWasRunning = $existing.Status -eq 'Running'
      $serviceProcessId = (Get-CimInstance Win32_Service -Filter "Name='$ServiceName'").ProcessId
      Stop-Service -Name $ServiceName -Force -ErrorAction Stop
      $serviceStoppedForUpgrade = $true
      $stoppedStatus = [Enum]::Parse($existing.Status.GetType(), 'Stopped')
      $existing.WaitForStatus($stoppedStatus, [TimeSpan]::FromSeconds(30))
      if ($serviceProcessId -gt 0) {
        Wait-Process -Id $serviceProcessId -Timeout 30 -ErrorAction SilentlyContinue
      }
    }

    $copyCompleted = $false
    $copyFailure = $null
    for ($attempt = 1; $attempt -le 30; $attempt++) {
      try {
        [IO.File]::Copy($temporary, $agentPath, $true)
        $copyCompleted = $true
        break
      }
      catch [IO.IOException] {
        $copyFailure = $_.Exception
        Start-Sleep -Seconds 1
      }
      catch [System.UnauthorizedAccessException] {
        $copyFailure = $_.Exception
        Start-Sleep -Seconds 1
      }
    }
    if (-not $copyCompleted) {
      throw "Agent executable could not be replaced after 30 attempts: $($copyFailure.Message)"
    }
    & icacls.exe $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($existing) {
      & sc.exe config $ServiceName binPath= "`"$agentPath`"" start= delayed-auto obj= LocalSystem | Out-Null
    } else {
      & sc.exe create $ServiceName binPath= "`"$agentPath`"" start= delayed-auto obj= LocalSystem | Out-Null
    }
    & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
    Start-Service -Name $ServiceName

    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while (-not (Test-Path $stateFile) -and [DateTime]::UtcNow -lt $deadline) {
      $service = Get-Service -Name $ServiceName -ErrorAction Stop
      if ($service.Status -ne 'Running') { throw "NachoAgent stopped before enrollment completed (status: $($service.Status))." }
      Start-Sleep -Seconds 1
    }
    if (-not (Test-Path $stateFile)) {
      throw 'NachoAgent started, but device enrollment did not complete within 45 seconds.'
    }

    $serviceStoppedForUpgrade = $false
    Write-Host "Nacho Agent $($manifest.version) installed, enrolled, and started."
  }
  finally {
    if (Test-Path $temporary) { Remove-Item -Force $temporary }
  }
}
catch {
  if ($serviceStoppedForUpgrade -and $serviceWasRunning -and (Test-Path $agentPath)) {
    try { Start-Service -Name $ServiceName -ErrorAction Stop }
    catch { Write-Warning "Failed to restore the existing NachoAgent service: $($_.Exception.Message)" }
  }
  Write-Error "Nacho Agent installation failed: $($_.Exception.Message)`nLog: $LogFile"
  if ($env:NACHO_INSTALL_NO_PAUSE -ne '1' -and [Environment]::UserInteractive) {
    Read-Host 'Press Enter to close this elevated installer window'
  }
  throw
}
finally {
  Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}
