[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Status", "Start", "ForceStop", "EnableAutostart", "DisableAutostart", "SetFirewall", "ApplyFirewall", "RemoveFirewall", "RemoveFirewallElevated")]
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

Assert-TrustedProject

switch ($Action) {
    "Status" {
        Remove-StalePid
        $Managed = Get-ManagedProcess
        $AutoStart = $false
        try {
            $AutoStart = $null -ne (Get-ItemProperty -LiteralPath $RunKey -Name $RunValueName -ErrorAction Stop).$RunValueName
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
        if ($null -ne $Managed) {
            try { $StartedAt = ([Management.ManagementDateTimeConverter]::ToDateTime($Managed.CreationDate)).ToUniversalTime().ToString("o") } catch {}
        }
        [ordered]@{
            running = $null -ne $Managed
            pid = if ($null -ne $Managed) { [int]$Managed.ProcessId } else { $null }
            startedAt = $StartedAt
            autoStartEnabled = $AutoStart
            firewallPorts = @($FirewallPorts | Sort-Object -Unique)
        } | ConvertTo-Json -Compress
    }
    "Start" {
        if (-not (Test-Path -LiteralPath $EntryPath)) { throw "缺少 dist/index.js，请先构建服务端" }
        New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
        Remove-StalePid
        if ($null -ne (Get-ManagedProcess)) { exit 0 }
        $Node = Get-Command "node.exe" -ErrorAction Stop
        $Child = Start-Process -FilePath $Node.Source -ArgumentList @($EntryPath) -WorkingDirectory $ServerDir -WindowStyle Hidden -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -PassThru
        Set-Content -LiteralPath $PidPath -Value ([string]$Child.Id) -Encoding ASCII -NoNewline
    }
    "ForceStop" {
        $Managed = Get-ManagedProcess
        if ($null -ne $Managed) { Stop-Process -Id ([int]$Managed.ProcessId) -Force -ErrorAction Stop }
        Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    }
    "EnableAutostart" {
        New-Item -Path $RunKey -Force | Out-Null
        $Command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Action Start' -f $PSCommandPath
        Set-ItemProperty -LiteralPath $RunKey -Name $RunValueName -Value $Command -Type String
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
