import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

// Windows 本机部署脚本的断言归服务端仓库维护：
// 面板仓库只验证面板自身代码，不再持有服务端源码副本。
const deployDir = path.resolve("deploy")
const windowsDir = path.join(deployDir, "windows")
const scriptPath = path.join(windowsDir, "local-control-server.ps1")
const launcherPath = path.join(windowsDir, "start-local-control-server.cjs")
const installPath = path.join(deployDir, "install.sh")

test("Windows 管理脚本保留 Windows PowerShell 5.1 需要的 UTF-8 BOM", () => {
  const script = fs.readFileSync(scriptPath)
  assert.deepEqual([...script.subarray(0, 3)], [0xef, 0xbb, 0xbf])
})

test("Windows 管理脚本校验受信项目、PID 归属与监听端口", () => {
  const script = fs.readFileSync(scriptPath, "utf8")

  assert.match(script, /\[Console\]::OutputEncoding = \$Utf8NoBom/)
  assert.doesNotMatch(script, /\uFFFD/)
  assert.match(script, /Assert-TrustedProject/)
  assert.match(script, /\[System\.IO\.File\]::ReadAllText\(\$ManifestPath, \[System\.Text\.Encoding\]::UTF8\)/)
  assert.match(script, /Win32_Process/)
  assert.match(script, /CommandLine\.ToLowerInvariant\(\)\.Contains\(\$Expected\)/)
  assert.match(script, /function Get-TcpListeners/)
  assert.match(script, /netstat\.exe/)
  assert.doesNotMatch(script, /Get-NetTCPConnection/)
  assert.match(script, /Where-Object \{ \$_\.OwningProcess -eq \$Managed\.ProcessId \}/)
  assert.match(script, /listeningPorts = @\(\$ListeningPorts\)/)
  assert.match(script, /portOwnerPid = if \(\$PortOwner\)/)
})

test("Windows 管理脚本导入受管环境变量并用运行时 Node 启动服务", () => {
  const script = fs.readFileSync(scriptPath, "utf8")

  assert.match(script, /function Import-ManagedEnvironment/)
  assert.match(script, /SetEnvironmentVariable\(\$Matches\.key, \$Matches\.value, "Process"\)/)
  assert.match(script, /Import-ManagedEnvironment\s+[\s\S]*& \$Runtime\.nodePath \$LauncherPath/)
  assert.match(script, /本机控制服务启动器未返回有效 PID/)
  assert.match(script, /Write-Output "控制服务进程已启动（PID \$ChildPid）"\s+exit 0/)
})

test("Windows 管理脚本在改动系统状态前中止端口占用并清理失败安装", () => {
  const script = fs.readFileSync(scriptPath, "utf8")

  assert.match(script, /"AssertPortAvailable"/)
  assert.match(script, /function Assert-PortAvailable/)
  assert.match(script, /端口 \$SelectedPort 已被其他进程占用，请更换监听端口后重试。/)
})

test("Windows 管理脚本把提权限制在防火墙规则，开机自启使用所选端口", () => {
  const script = fs.readFileSync(scriptPath, "utf8")

  assert.match(script, /-Verb RunAs/)
  assert.match(script, /-RemoteAddress LocalSubnet/)
  assert.match(script, /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run/)
  assert.match(script, /-Action Start -Port \{1\}/)
  assert.doesNotMatch(script, /Start-Process[^\r\n]+-Verb RunAs[^\r\n]+\$Runtime\.nodePath/)
})

test("Windows 管理脚本优先复用面板运行时，再安装已校验的便携 Node.js", () => {
  const script = fs.readFileSync(scriptPath, "utf8")

  assert.match(script, /\[Environment\]::GetEnvironmentVariable\("Path", "Machine"\)/)
  assert.match(script, /\$PanelNodePath/)
  assert.match(script, /RuntimeInformation\]::OSArchitecture/)
  assert.match(script, /-p "process\.arch"/)
  assert.match(script, /Join-Path \(Split-Path -Parent \$NodePath\) "npm\.cmd"/)
  assert.match(script, /Get-Command where\.exe/)
  assert.match(script, /node_modules\\npm\\bin\\npm-cli\.js/)
  assert.match(script, /& \$NodePath \$NpmCliPath --version/)
  assert.match(script, /\$PreviousErrorActionPreference = \$ErrorActionPreference/)
  assert.match(script, /\$ErrorActionPreference = "Continue"/)
  assert.match(script, /if \(\$Candidate\.ready\)/)
  assert.match(script, /"InstallRuntime"/)
  assert.match(script, /https:\/\/nodejs\.org\/dist\/index\.json/)
  assert.match(script, /SHASUMS256\.txt/)
  assert.match(script, /Get-FileHash -LiteralPath \$ArchivePath -Algorithm SHA256/)
  assert.match(script, /\.nacho-runtime/)
  assert.match(script, /OpenJS\.NodeJS\.LTS/)
  assert.equal(script.match(/function Get-NodeRuntimeInfo/g)?.length, 1)
  assert.doesNotMatch(script, /请先安装 Microsoft App Installer/)
  assert.match(script, /Write-Output '\$ npm ci --no-audit --no-fund'/)
  assert.match(script, /& \$Runtime\.npmPath ci --no-audit --no-fund/)
  assert.match(script, /Write-Output '\$ npm run build'/)
  assert.match(script, /& \$Runtime\.npmPath run build/)
  assert.match(script, /& \$Runtime\.nodePath \$LauncherPath/)
  assert.doesNotMatch(script, /RedirectStandardOutput \$StdoutPath/)
})

test("Windows 启动器不继承安装管道并脱离父进程", () => {
  const launcher = fs.readFileSync(launcherPath, "utf8")

  assert.match(launcher, /detached: true/)
  assert.match(launcher, /stdio: \["ignore", stdoutDescriptor, stderrDescriptor\]/)
  assert.match(launcher, /child\.unref\(\)/)
  assert.doesNotMatch(launcher, /shell: true/)
})

test("Linux 安装脚本在隐藏安装密钥时保留真实输出", () => {
  const install = fs.readFileSync(installPath, "utf8")

  assert.match(install, /NACHO_HIDE_INSTALL_SECRETS/)
  assert.match(install, /hide_keys=1/)
  assert.match(install, /Panel API Key: 已隐藏/)
})

test("RunMode 可选参数不在 PowerShell 参数绑定阶段拒绝空值", () => {
  const script = fs.readFileSync(path.join(windowsDir, "nacho.ps1"), "utf8")

  assert.match(script, /^\uFEFF?param\(\s*\[string\]\$RunMode\s*,/)
  assert.doesNotMatch(script, /\[ValidateSet\([^\]]+\)\]\s*\[string\]\$RunMode/)
  assert.match(script, /IsNullOrWhiteSpace\(\$RunMode\)[\s\S]*\$RunMode -notin @\('menu', 'silent'\)/)
})
