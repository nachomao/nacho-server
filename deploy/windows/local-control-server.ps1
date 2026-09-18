[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Status", "InstallRuntime", "Build", "Start", "ForceStop", "EnableAutostart", "DisableAutostart", "SetFirewall", "ApplyFirewall", "RemoveFirewall", "RemoveFirewallElevated")]
    [string]$Action,

    [ValidateRange(1024, 65535)]
    [int]$Port = 8443,

    [string]$PanelNodePath = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$ServerDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$EntryPath = [System.IO.Path]::GetFullPath((Join-Path $ServerDir "dist\index.js"))
$EnvironmentPath = Join-Path $ServerDir ".env"
$StateDir = Join-Path $ServerDir ".nacho-local"
$PidPath = Join-Path $StateDir "server.pid"
$StdoutPath = Join-Path $StateDir "server.stdout.log"
$StderrPath = Join-Path $StateDir "server.stderr.log"
$RuntimeRoot = Join-Path $ServerDir ".nacho-runtime"
$ManagedNodeDir = Join-Path $RuntimeRoot "node"
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$RunValueName = "NachoControlServer"
$FirewallPrefix = "NachoPanel-Local-Control-"

function Assert-TrustedProject {
    $ManifestPath = Join-Path $ServerDir "package.json"
    if (-not (Test-Path -LiteralPath $ManifestPath)) { throw "缺少 server/package.json" }
    $Manifest = [System.IO.File]::ReadAllText($ManifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($Manifest.name -ne "nacho-server") { throw "目标目录不是 Nacho 服务端项目" }
}

function Import-ManagedEnvironment {
    if (-not (Test-Path -LiteralPath $EnvironmentPath -PathType Leaf)) { throw "缺少 server/.env" }
    foreach ($Line in [System.IO.File]::ReadAllLines($EnvironmentPath, [System.Text.Encoding]::UTF8)) {
        if ($Line -match '^(?<key>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$') {
            [Environment]::SetEnvironmentVariable($Matches.key, $Matches.value, "Process")
        }
    }
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
    $env:Path = (@($MachinePath, $UserPath, $env:Path) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ";"
}

function Get-NodeArchiveArchitecture {
    $ArchitectureCandidates = @()

    try {
        $ArchitectureCandidates += [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    }
    catch {}

    if (-not [string]::IsNullOrWhiteSpace($PanelNodePath) -and (Test-Path -LiteralPath $PanelNodePath -PathType Leaf)) {
        try {
            $ArchitectureCandidates += (& $PanelNodePath -p "process.arch" 2>$null | Select-Object -First 1)
        }
        catch {}
    }

    $ArchitectureCandidates += @(
        $env:PROCESSOR_ARCHITEW6432,
        $env:PROCESSOR_ARCHITECTURE
    )

    foreach ($Architecture in $ArchitectureCandidates) {
        switch -Regex ([string]$Architecture) {
            '^(?i:ARM64)$' { return "arm64" }
            '^(?i:AMD64|IA64|X64)$' { return "x64" }
            '^(?i:x86|ia32)$' { return "x86" }
        }
    }

    return $null
}

function Get-NodeRuntimeDetails {
    param(
        [AllowNull()][string]$NodePath,
        [AllowNull()][string]$NpmPath,
        [bool]$Managed
    )

    $NodeVersion = $null
    $NodeReady = $false

    if (-not [string]::IsNullOrWhiteSpace($NodePath) -and (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        try {
            $NodeVersion = (& $NodePath --version 2>$null | Select-Object -First 1).Trim()
            if ($NodeVersion -match '^v(?<major>\d+)\.') {
                $NodeReady = [int]$Matches.major -ge 22
            }
        }
        catch {
            $NodeVersion = $null
        }
    }

    $NpmVersion = $null
    $NpmReady = $false
    $NpmCliPath = $null
    if (-not [string]::IsNullOrWhiteSpace($NpmPath) -and (Test-Path -LiteralPath $NpmPath -PathType Leaf)) {
        $PreviousPath = $env:Path
        $PreviousErrorActionPreference = $ErrorActionPreference
        try {
            if (-not [string]::IsNullOrWhiteSpace($NodePath)) {
                $env:Path = "$(Split-Path -Parent $NodePath);$env:Path"
            }
            $ErrorActionPreference = "Continue"

            if ([System.IO.Path]::GetExtension($NpmPath) -eq ".cmd") {
                $CandidateNpmCliPath = Join-Path (Split-Path -Parent $NpmPath) "node_modules\npm\bin\npm-cli.js"
                if (-not $NodeReady -or -not (Test-Path -LiteralPath $CandidateNpmCliPath -PathType Leaf)) {
                    throw "npm.cmd 缺少可由 Node.js 直接执行的 npm-cli.js"
                }
                $NpmCliPath = $CandidateNpmCliPath
                $NpmOutput = @(& $NodePath $NpmCliPath --version 2>$null)
            }
            else {
                $NpmOutput = @(& $NpmPath --version 2>$null)
            }
            $NpmExitCode = $LASTEXITCODE
            $NpmVersion = ([string]($NpmOutput | Select-Object -First 1)).Trim()
            $NpmReady = $NpmExitCode -eq 0 -and $NpmVersion -match '^\d+\.'
        }
        catch {
            $NpmVersion = $null
        }
        finally {
            $env:Path = $PreviousPath
            $ErrorActionPreference = $PreviousErrorActionPreference
        }
    }

    return [pscustomobject]@{
        nodePath = if ($NodeReady) { $NodePath } else { $null }
        npmPath = if ($NpmReady) { $NpmPath } else { $null }
        npmCliPath = if ($NpmReady) { $NpmCliPath } else { $null }
        nodeVersion = $NodeVersion
        nodeReady = $NodeReady
        npmVersion = $NpmVersion
        npmAvailable = $NpmReady
        ready = ($NodeReady -and $NpmReady)
        managed = $Managed
    }
}

function Get-NodeRuntimeInfo {
    Update-ProcessPath

    $Candidates = @()
    $ManagedNodePath = Join-Path $ManagedNodeDir "node.exe"
    $ManagedNpmPath = Join-Path $ManagedNodeDir "npm.cmd"
    if ((Test-Path -LiteralPath $ManagedNodePath -PathType Leaf) -or (Test-Path -LiteralPath $ManagedNpmPath -PathType Leaf)) {
        $Candidates += Get-NodeRuntimeDetails -NodePath $ManagedNodePath -NpmPath $ManagedNpmPath -Managed $true
    }

    $NodePaths = @($PanelNodePath)
    $NodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($NodeCommand) { $NodePaths += $NodeCommand.Source }
    foreach ($Directory in @($env:NVM_SYMLINK, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ([string]::IsNullOrWhiteSpace($Directory)) { continue }
        if ($Directory -eq $env:NVM_SYMLINK) {
            $NodePaths += Join-Path $Directory "node.exe"
        }
        else {
            $NodePaths += Join-Path $Directory "nodejs\node.exe"
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $NodePaths += Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"
    }
    $NodePaths = @($NodePaths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique)

    $Selected = $Candidates | Where-Object { $_.ready } | Select-Object -First 1
    $TestedPairs = @{}
    if (-not $Selected) {
        foreach ($NodePath in $NodePaths) {
            $SiblingNpmPath = Join-Path (Split-Path -Parent $NodePath) "npm.cmd"
            if (-not (Test-Path -LiteralPath $SiblingNpmPath -PathType Leaf)) { continue }
            $PairKey = "$($NodePath.ToLowerInvariant())`n$($SiblingNpmPath.ToLowerInvariant())"
            $Candidate = Get-NodeRuntimeDetails -NodePath $NodePath -NpmPath $SiblingNpmPath -Managed $false
            $TestedPairs[$PairKey] = $true
            $Candidates += $Candidate
            if ($Candidate.ready) {
                $Selected = $Candidate
                break
            }
        }
    }

    $NpmPaths = @()
    foreach ($NodePath in $NodePaths) {
        $NpmPaths += Join-Path (Split-Path -Parent $NodePath) "npm.cmd"
    }
    if (-not $Selected) {
        foreach ($CommandName in @("npm.cmd", "npm.exe", "npm")) {
            $NpmCommand = Get-Command $CommandName -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($NpmCommand -and -not [string]::IsNullOrWhiteSpace($NpmCommand.Source)) {
                $NpmPaths += $NpmCommand.Source
            }
        }
        $WhereCommand = Get-Command where.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($WhereCommand) {
            $NpmPaths += @(& $WhereCommand.Source npm.cmd 2>$null)
            $NpmPaths += @(& $WhereCommand.Source npm 2>$null)
        }
    }
    $NpmPaths = @($NpmPaths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique)

    if (-not $Selected) {
        foreach ($NodePath in $NodePaths) {
            $SiblingNpmPath = Join-Path (Split-Path -Parent $NodePath) "npm.cmd"
            $OrderedNpmPaths = @($SiblingNpmPath) + @($NpmPaths | Where-Object { $_ -ne $SiblingNpmPath })
            $AddedCandidate = $false
            foreach ($NpmPath in ($OrderedNpmPaths | Select-Object -Unique)) {
                if (-not (Test-Path -LiteralPath $NpmPath -PathType Leaf)) { continue }
                $PairKey = "$($NodePath.ToLowerInvariant())`n$($NpmPath.ToLowerInvariant())"
                if ($TestedPairs.ContainsKey($PairKey)) { continue }
                $Candidate = Get-NodeRuntimeDetails -NodePath $NodePath -NpmPath $NpmPath -Managed $false
                $TestedPairs[$PairKey] = $true
                $Candidates += $Candidate
                $AddedCandidate = $true
                if ($Candidate.ready) {
                    $Selected = $Candidate
                    break
                }
            }
            if ($Selected) { break }
            if (-not $AddedCandidate -and -not ($Candidates | Where-Object { $_.nodePath -eq $NodePath } | Select-Object -First 1)) {
                $Candidates += Get-NodeRuntimeDetails -NodePath $NodePath -NpmPath $null -Managed $false
            }
        }
    }

    if (-not $Selected) {
        $Selected = $Candidates | Where-Object { $_.nodeReady } | Select-Object -First 1
    }
    if (-not $Selected) {
        $Selected = $Candidates | Select-Object -First 1
    }
    if ($Selected -and $Selected.nodePath) {
        $env:Path = "$(Split-Path -Parent $Selected.nodePath);$env:Path"
    }

    $WingetCommand = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    return [pscustomobject]@{
        nodePath = if ($Selected) { $Selected.nodePath } else { $null }
        npmPath = if ($Selected) { $Selected.npmPath } else { $null }
        npmCliPath = if ($Selected) { $Selected.npmCliPath } else { $null }
        nodeVersion = if ($Selected) { $Selected.nodeVersion } else { $null }
        nodeReady = if ($Selected) { $Selected.nodeReady } else { $false }
        npmAvailable = if ($Selected) { $Selected.npmAvailable } else { $false }
        ready = if ($Selected) { $Selected.ready } else { $false }
        managed = if ($Selected) { $Selected.managed } else { $false }
        runtimeInstallerAvailable = [bool](Get-NodeArchiveArchitecture) -or [bool]$WingetCommand
        wingetPath = if ($WingetCommand) { $WingetCommand.Source } else { $null }
    }
}

function Install-PortableNodeRuntime {
    $Architecture = Get-NodeArchiveArchitecture
    if ([string]::IsNullOrWhiteSpace($Architecture)) {
        throw "当前 Windows 处理器架构不受 Node.js 官方便携包支持。"
    }

    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null

    $Index = @(Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -Method Get -TimeoutSec 60 -ErrorAction Stop)
    $Release = $Index |
        Where-Object {
            $_.lts -and
            ([int]((([string]$_.version).TrimStart("v").Split('.'))[0]) -ge 22) -and
            ($_.files -contains "win-$Architecture-zip")
        } |
        Sort-Object -Property @{ Expression = { [version](([string]$_.version).TrimStart("v")) } } -Descending |
        Select-Object -First 1

    if (-not $Release) {
        throw "未找到适用于 win-$Architecture 的 Node.js 22+ LTS 官方便携包。"
    }

    $Version = [string]$Release.version
    $ArchiveName = "node-$Version-win-$Architecture.zip"
    $DownloadRoot = "https://nodejs.org/dist/$Version"
    $ArchivePath = Join-Path $StateDir $ArchiveName
    $ChecksumsPath = Join-Path $StateDir "$Version-SHASUMS256.txt"
    $ExtractPath = Join-Path $RuntimeRoot "extract-$Version"
    $BackupPath = Join-Path $RuntimeRoot "node-backup"

    try {
        Invoke-WebRequest -Uri "$DownloadRoot/$ArchiveName" -OutFile $ArchivePath -UseBasicParsing -TimeoutSec 900 -ErrorAction Stop
        Invoke-WebRequest -Uri "$DownloadRoot/SHASUMS256.txt" -OutFile $ChecksumsPath -UseBasicParsing -TimeoutSec 60 -ErrorAction Stop

        $ChecksumLine = Get-Content -LiteralPath $ChecksumsPath |
            Where-Object { $_ -match "^(?<hash>[a-fA-F0-9]{64})\s+$([regex]::Escape($ArchiveName))$" } |
            Select-Object -First 1
        if (-not $ChecksumLine -or $ChecksumLine -notmatch "^(?<hash>[a-fA-F0-9]{64})") {
            throw "Node.js 官方校验文件中缺少 $ArchiveName。"
        }

        $ExpectedHash = $Matches.hash.ToUpperInvariant()
        $ActualHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToUpperInvariant()
        if ($ActualHash -ne $ExpectedHash) {
            throw "Node.js 便携包 SHA-256 校验失败。"
        }

        Remove-Item -LiteralPath $ExtractPath -Recurse -Force -ErrorAction SilentlyContinue
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractPath -Force
        $ExtractedNodeDir = Join-Path $ExtractPath "node-$Version-win-$Architecture"
        if (-not (Test-Path -LiteralPath (Join-Path $ExtractedNodeDir "node.exe") -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Join-Path $ExtractedNodeDir "npm.cmd") -PathType Leaf)) {
            throw "Node.js 官方便携包内容不完整。"
        }

        Remove-Item -LiteralPath $BackupPath -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $ManagedNodeDir) {
            Move-Item -LiteralPath $ManagedNodeDir -Destination $BackupPath -Force
        }

        try {
            Move-Item -LiteralPath $ExtractedNodeDir -Destination $ManagedNodeDir -Force
        }
        catch {
            if (Test-Path -LiteralPath $BackupPath) {
                Move-Item -LiteralPath $BackupPath -Destination $ManagedNodeDir -Force
            }
            throw
        }

        Remove-Item -LiteralPath $BackupPath -Recurse -Force -ErrorAction SilentlyContinue
    }
    finally {
        Remove-Item -LiteralPath $ArchivePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $ChecksumsPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $ExtractPath -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Install-NodeRuntimeWithWinget {
    param([string]$WingetPath)

    if ([string]::IsNullOrWhiteSpace($WingetPath)) {
        throw "Windows Package Manager 不可用，无法执行备用安装。"
    }

    & $WingetPath install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements --silent --disable-interactivity
    if ($LASTEXITCODE -ne 0) {
        throw "Windows Package Manager 安装 Node.js LTS 失败，退出代码：$LASTEXITCODE。"
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
        $PortOwner = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1

        [ordered]@{
            running = [bool]$Managed
            pid = if ($Managed) { [int]$Managed.ProcessId } else { $null }
            startedAt = $StartedAt
            autoStartEnabled = $AutoStart
            firewallPorts = @($FirewallPorts)
            listeningPorts = @($ListeningPorts)
            portOwnerPid = if ($PortOwner) { [int]$PortOwner.OwningProcess } else { $null }
            nodeReady = $Runtime.nodeReady
            nodeVersion = $Runtime.nodeVersion
            npmAvailable = $Runtime.npmAvailable
            runtimeInstallerAvailable = $Runtime.runtimeInstallerAvailable
        } | ConvertTo-Json -Compress
    }
    "InstallRuntime" {
        $Runtime = Get-NodeRuntimeInfo
        if ($Runtime.ready) {
            @{ ok = $true; runtime = $Runtime } | ConvertTo-Json -Compress
            break
        }

        $PortableError = $null
        try {
            Install-PortableNodeRuntime
        }
        catch {
            $PortableError = $_.Exception.Message
            if (-not [string]::IsNullOrWhiteSpace($Runtime.wingetPath)) {
                try {
                    Install-NodeRuntimeWithWinget -WingetPath $Runtime.wingetPath
                    Update-ProcessPath
                }
                catch {
                    throw "Node.js LTS 便携运行环境安装失败（$PortableError）；备用系统安装也失败：$($_.Exception.Message)"
                }
            }
            else {
                throw "Node.js LTS 便携运行环境安装失败：$PortableError"
            }
        }

        $InstalledRuntime = Get-NodeRuntimeInfo
        if (-not $InstalledRuntime.ready) {
            if ($PortableError) {
                throw "便携运行环境安装失败（$PortableError），备用系统安装完成后仍未检测到 Node.js 22+ 与 npm。请重新打开面板后重试。"
            }
            throw "Node.js LTS 便携运行环境安装完成，但未检测到 Node.js 22+ 与 npm。"
        }

        @{ ok = $true; runtime = $InstalledRuntime } | ConvertTo-Json -Compress
        break
    }
    "Build" {
        $Runtime = Get-NodeRuntimeInfo
        if (-not $Runtime.nodeReady -or -not $Runtime.npmAvailable) { throw "缺少 Node.js 22+ 或 npm" }
        Push-Location $ServerDir
        try {
            if ($Runtime.npmCliPath) {
                & $Runtime.nodePath $Runtime.npmCliPath ci --no-audit --no-fund
            }
            else {
                & $Runtime.npmPath ci --no-audit --no-fund
            }
            if ($LASTEXITCODE -ne 0) { throw "npm ci 失败（退出码 $LASTEXITCODE）" }
            if ($Runtime.npmCliPath) {
                & $Runtime.nodePath $Runtime.npmCliPath run build
            }
            else {
                & $Runtime.npmPath run build
            }
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
        Import-ManagedEnvironment
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
