[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Status", "InstallRuntime", "Build", "Start", "ForceStop", "EnableAutostart", "DisableAutostart", "SetFirewall", "ApplyFirewall", "RemoveFirewall", "RemoveFirewallElevated")]
    [string]$Action,

    [ValidateRange(1024, 65535)]
    [int]$Port = 8443
)

$ErrorActionPreference = "Stop"
$ServerDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$EntryPath = [System.IO.Path]::GetFullPath((Join-Path $ServerDir "dist\index.js"))
$StateDir = Join-Path $ServerDir ".nacho-local"
$PidPath = Join-Path $StateDir "server.pid"
$StdoutPath = Join-Path $StateDir "server.stdout.log"
$StderrPath = Join-Path $StateDir "server.stderr.log"
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$RunValueName = "NachoControlServer"
$FirewallPrefix = "NachoPanel-Local-Control-"

function Assert-TrustedProject {
    $ManifestPath = Join-Path $ServerDir "package.json"
    if (-not (Test-Path -LiteralPath $ManifestPath)) { throw "缺少 server/package.json" }
    $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ($Manifest.name -ne "nacho-server") { throw "目标目录不是 Nacho 服务端项目" }
}

function Get-ManagedProcess {
    if (-not (Test-Path -LiteralPath $PidPath)) { return $null }
    $StoredPid = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $PidPath -Raw).Trim(), [ref]$StoredPid)) { return $null }
    try {
        $ProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $StoredPid"
        if ($null -eq $ProcessInfo) { return $null }
        $Expected = $EntryPath.ToLowerInvariant()
        $CommandLine = [string]$ProcessInfo.CommandLine
        if (-not $CommandLine.ToLowerInvariant().Contains($Expected)) { return $null }
        return $ProcessInfo
    } catch {
        return $null
    }
}

function Remove-StalePid {
    if ($null -eq (Get-ManagedProcess)) { Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue }
}

function Test-Administrator {
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
    return $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-ElevatedAction([string]$ElevatedAction, [int]$SelectedPort) {
    $Arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", ('"{0}"' -f $PSCommandPath),
        "-Action", $ElevatedAction,
        "-Port", [string]$SelectedPort
    )
    try {
        $Child = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $Arguments -Wait -PassThru
    } catch {
        throw "Windows 管理员授权被取消或无法启动：$($_.Exception.Message)"
    }
    if ($Child.ExitCode -ne 0) { throw "Windows 防火墙配置失败（退出码 $($Child.ExitCode)）" }
}

function Remove-ManagedFirewallRules {
    Get-NetFirewallRule -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "$FirewallPrefix*" } |
        Remove-NetFirewallRule -ErrorAction Stop
}

function Update-ProcessPath {
    $MachinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = (@($MachinePath, $UserPath, $env:Path) | Where-Object { $_ }) -join ";"
}

function Get-NodeRuntimeInfo {
    Update-ProcessPath
    $Node = Get-Command "node.exe" -ErrorAction SilentlyContinue
    $Npm = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
    $NodeVersion = $null
    $NodeMajor = 0
    if ($Node) {
        try {
            $NodeVersion = ([string](& $Node.Source --version)).Trim().TrimStart("v")
            if ($NodeVersion -match "^(\d+)\.") { $NodeMajor = [int]$Matches[1] }
        } catch {}
    }
    $NpmAvailable = $false
    if ($Npm) {
        try {
            & $Npm.Source --version *> $null
            $NpmAvailable = $LASTEXITCODE -eq 0
        } catch {}
    }
    $Winget = Get-Command "winget.exe" -ErrorAction SilentlyContinue

    return [pscustomobject]@{
        nodeReady = [bool]($Node -and $NodeMajor -ge 22)
        nodeVersion = if ($NodeVersion) { $NodeVersion } else { "未检测到" }
        nodePath = if ($Node) { $Node.Source } else { $null }
        npmAvailable = $NpmAvailable
        npmPath = if ($Npm) { $Npm.Source } else { $null }
        runtimeInstallerAvailable = [bool]$Winget
        wingetPath = if ($Winget) { $Winget.Source } else { $null }
    }
}

function Get-AutostartCommand {
    return 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Action Start -Port {1}' -f $PSCommandPath, $Port
}

Assert-TrustedProject

switch ($Action) {
    "Status" {
        Remove-StalePid
        $Runtime = Get-NodeRuntimeInfo
        $Managed = Get-ManagedProcess
        $AutoStart = $false
        try {
            $AutoStart = (Get-ItemProperty -LiteralPath $RunKey -Name $RunValueName -ErrorAction Stop).$RunValueName -eq (Get-AutostartCommand)
        } catch {}
        $FirewallPorts = @()
        try {
            $Rules = Get-NetFirewallRule -ErrorAction Stop | Where-Object { $_.Name -like "$FirewallPrefix*" }
            foreach ($Rule in $Rules) {
                $Filter = $Rule | Get-NetFirewallPortFilter
                $ParsedPort = 0
                if ([int]::TryParse([string]$Filter.LocalPort, [ref]$ParsedPort)) { $FirewallPorts += $ParsedPort }
            }
        } catch {}
        $StartedAt = $null
        $ListeningPorts = @()
        if ($Managed) {
            $StartedAt = $Managed.CreationDate.ToUniversalTime().ToString("o")
            $ListeningPorts = @(
                Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
                    Where-Object { $_.OwningProcess -eq $Managed.ProcessId } |
                    Select-Object -ExpandProperty LocalPort -Unique
            )
        }

        [ordered]@{
            running = [bool]$Managed
            pid = if ($Managed) { [int]$Managed.ProcessId } else { $null }
            startedAt = $StartedAt
            autoStartEnabled = $AutoStart
            firewallPorts = @($FirewallPorts)
            listeningPorts = @($ListeningPorts)
            nodeReady = $Runtime.nodeReady
            nodeVersion = $Runtime.nodeVersion
            npmAvailable = $Runtime.npmAvailable
            runtimeInstallerAvailable = $Runtime.runtimeInstallerAvailable
        } | ConvertTo-Json -Compress
    }
    "InstallRuntime" {
        $Runtime = Get-NodeRuntimeInfo
        if ($Runtime.nodeReady -and $Runtime.npmAvailable) { exit 0 }
        if (-not $Runtime.runtimeInstallerAvailable) { throw "未找到 Windows Package Manager（winget）" }

        $WingetOutput = & $Runtime.wingetPath install --id OpenJS.NodeJS.LTS --exact --source winget --silent --force --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            $Detail = $WingetOutput.Trim()
            if (-not $Detail) { $Detail = "退出码 $LASTEXITCODE" }
            throw "Node.js LTS 自动安装失败：$Detail"
        }

        $InstalledRuntime = Get-NodeRuntimeInfo
        if (-not $InstalledRuntime.nodeReady -or -not $InstalledRuntime.npmAvailable) {
            throw "安装完成后仍未检测到 Node.js 22+ 与 npm"
        }
    }
    "Build" {
        $Runtime = Get-NodeRuntimeInfo
        if (-not $Runtime.nodeReady -or -not $Runtime.npmAvailable) { throw "缺少 Node.js 22+ 或 npm" }
        Push-Location $ServerDir
        try {
            & $Runtime.npmPath ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "npm ci 失败（退出码 $LASTEXITCODE）" }
            & $Runtime.npmPath run build
            if ($LASTEXITCODE -ne 0) { throw "npm run build 失败（退出码 $LASTEXITCODE）" }
        } finally {
            Pop-Location
        }
    }
    "Start" {
        if (-not (Test-Path -LiteralPath $EntryPath)) { throw "缺少 dist/index.js，请先构建服务端" }
        New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
        Remove-StalePid
        if ($null -ne (Get-ManagedProcess)) { exit 0 }
        $PortOwner = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($PortOwner) { throw "端口 $Port 已被进程 $($PortOwner.OwningProcess) 占用" }
        $Runtime = Get-NodeRuntimeInfo
        if (-not $Runtime.nodeReady) { throw "缺少 Node.js 22 或更高版本" }
        $QuotedEntryPath = '"' + $EntryPath.Replace('"', '\"') + '"'
        $Child = Start-Process -FilePath $Runtime.nodePath -ArgumentList @($QuotedEntryPath) -WorkingDirectory $ServerDir -WindowStyle Hidden -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -PassThru
        Set-Content -LiteralPath $PidPath -Value ([string]$Child.Id) -Encoding ASCII -NoNewline
    }
    "ForceStop" {
        $Managed = Get-ManagedProcess
        if ($null -ne $Managed) { Stop-Process -Id ([int]$Managed.ProcessId) -Force -ErrorAction Stop }
        Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    }
    "EnableAutostart" {
        New-Item -Path $RunKey -Force | Out-Null
        Set-ItemProperty -LiteralPath $RunKey -Name $RunValueName -Value (Get-AutostartCommand) -Type String
    }
    "DisableAutostart" {
        Remove-ItemProperty -LiteralPath $RunKey -Name $RunValueName -Force -ErrorAction SilentlyContinue
    }
    "SetFirewall" {
        if (Test-Administrator) {
            Remove-ManagedFirewallRules
            New-NetFirewallRule -Name "$FirewallPrefix$Port" -DisplayName "NachoPanel 本地控制服务（TCP $Port）" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private -RemoteAddress LocalSubnet | Out-Null
        } else {
            Invoke-ElevatedAction "ApplyFirewall" $Port
        }
    }
    "ApplyFirewall" {
        if (-not (Test-Administrator)) { throw "该操作需要管理员权限" }
        Remove-ManagedFirewallRules
        New-NetFirewallRule -Name "$FirewallPrefix$Port" -DisplayName "NachoPanel 本地控制服务（TCP $Port）" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private -RemoteAddress LocalSubnet | Out-Null
    }
    "RemoveFirewall" {
        $HasRules = $false
        try { $HasRules = $null -ne (Get-NetFirewallRule -ErrorAction Stop | Where-Object { $_.Name -like "$FirewallPrefix*" } | Select-Object -First 1) } catch {}
        if (-not $HasRules) { exit 0 }
        if (Test-Administrator) { Remove-ManagedFirewallRules } else { Invoke-ElevatedAction "RemoveFirewallElevated" $Port }
    }
    "RemoveFirewallElevated" {
        if (-not (Test-Administrator)) { throw "该操作需要管理员权限" }
        Remove-ManagedFirewallRules
    }
}
