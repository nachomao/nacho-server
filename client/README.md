# Nacho Windows Agent

Windows 客户端负责设备注册、DPAPI 设备令牌持久化、心跳与指标、WebSocket 实时接收、HTTP 轮询回退、可靠指令确认，以及受本机策略约束的程序执行、Windows 服务控制、本机进程清单、进程终止与系统重启。

## 运行结构

- 目标：Windows x64，.NET 10，自包含单文件。
- 服务：`NachoAgent`，`LocalSystem`，自动启动，失败自动重启；Agent 在网络恢复后持续重连，并独立重试注册、心跳、WebSocket 与轮询。
- 程序：`%ProgramFiles%\Nacho\Agent\nacho-agent.exe`。
- 配置：`%ProgramData%\Nacho\agent.json`。
- 状态：`%ProgramData%\Nacho\state.dat`，使用 DPAPI `LocalMachine` 加密。
- 队列：`%ProgramData%\Nacho\queue\<commandId>.json`。
- 重启意图：`%ProgramData%\Nacho\restart-intent.json`，使用原子替换并跨系统启动核验。

## 构建与测试

```powershell
dotnet build server/client/src/Nacho.Agent/Nacho.Agent.csproj
dotnet test server/client/tests/Nacho.Agent.Tests/Nacho.Agent.Tests.csproj
powershell -ExecutionPolicy Bypass -File server/client/deploy/publish.ps1
```

发布脚本将单文件制品和 `latest.json` 写入 `server/artifacts/windows`，服务端随后通过公共下载路由提供这些文件。

当服务端从 WSL 部署副本（例如 `/opt/control-server`）运行时，发布后必须先把 `server/artifacts/windows` 中的新可执行文件与 `latest.json` 同步到该部署副本配置的 `ARTIFACTS_PATH/windows`，保持服务账户可读，再执行覆盖安装；验收前应比较下载清单、已安装文件和本地发布文件的 SHA-256，避免旧制品仍被下载。

## 服务端配置

```dotenv
ALLOW_OPEN_ENROLLMENT=true
ARTIFACTS_PATH=./artifacts
# 使用反向代理时建议显式填写：
PUBLIC_BASE_URL=https://nacho.example.com
TRUST_PROXY=false
```

`ALLOW_OPEN_ENROLLMENT=true` 时，安装过程不要求入网密钥；设为 `false` 时，首次安装会隐藏提示输入 `ENROLLMENT_KEY`。注册成功后临时密钥文件会被删除，后续请求仅使用设备 token。

## 一行安装

在管理员 PowerShell 中运行；普通 PowerShell 会自动触发 UAC 提权：

```powershell
irm http://SERVER:PORT/nacho.ps1 | iex
```

服务端可维护多个安装档案。裸 `/nacho.ps1` 使用默认档案；指定档案使用：

```powershell
irm "http://SERVER:PORT/nacho.ps1?profile=PROFILE_ID" | iex
```

档案保存 `menu` 或 `silent` 默认模式，以及 Agent 连接地址、心跳、HTTP 回退轮询、名称、分组和标签。一次性覆盖模式可使用：

```powershell
& { $env:NACHO_INSTALL_MODE='menu'; irm "http://SERVER:PORT/nacho.ps1?profile=PROFILE_ID" | iex }
& { $env:NACHO_INSTALL_MODE='silent'; irm "http://SERVER:PORT/nacho.ps1?profile=PROFILE_ID" | iex }
```

`silent` 自动选择安装、跳过菜单和失败暂停，仅保留最终结果与 `install.log`；普通用户启动时仍会显示 Windows UAC。关闭开放入网时，静默部署继续通过当前进程的 `NACHO_ENROLLMENT_KEY` 提供密钥，档案和 URL 均不保存该凭据。

Windows PowerShell 5.1 请使用上面的 `irm` 命令；裸用 `iwr URL | iex` 可能触发旧 Internet Explorer 解析器的 `NullReferenceException`。确需使用 `iwr` 时应写成 `iwr URL -UseBasicParsing | Select-Object -ExpandProperty Content | iex`。

重复运行会停止并升级现有服务、等待旧服务进程完全退出、重试替换被短暂占用的可执行文件、更新服务器地址，并保留设备身份和管理员维护的允许列表。档案可显式覆盖已有基础配置；切换到独立服务端时可显式备份并重建设备身份。升级中途失败时会恢复旧可执行文件、配置、设备状态和原服务运行状态。

安装器会把完整过程追加到 `%ProgramData%\Nacho\install.log`，启动服务后最多等待 45 秒确认 `state.dat` 已生成，只有设备真实注册完成才报告成功。提权子进程失败时，原 PowerShell 窗口会保留错误信息，交互运行的提权窗口也会等待确认后再关闭。

关闭开放入网时必须输入服务端 `.env` 中的 `ENROLLMENT_KEY`；空输入会立即报告错误。自动化系统可在当前安装进程中临时设置 `NACHO_ENROLLMENT_KEY`，安装完成后应立即清理该环境变量。

排查安装失败：

```powershell
Get-Content "$env:ProgramData\Nacho\install.log" -Tail 100
Get-WinEvent -LogName Application |
  Where-Object ProviderName -eq 'nacho-agent' |
  Select-Object -First 20 TimeCreated, LevelDisplayName, Message
```

卸载并保留设备状态：

```powershell
irm http://SERVER:PORT/uninstall.ps1 | iex
```

彻底清理：

```powershell
& ([scriptblock]::Create((irm http://SERVER:PORT/uninstall.ps1))) -Purge
```

## `run-shell` 契约

1.1.16 测试配置默认写入 `disableAllPolicies: true`。该字段只绕过 Agent 本机 allow/deny 门禁，payload、过期时间、路径格式、大小、会话和结果校验仍然执行；删除或设为 `false` 后，各项旧的细粒度策略重新生效。

```json
{
  "type": "run-shell",
  "payload": {
    "shell": "cmd",
    "script": "ver",
    "timeoutSeconds": 30
  }
}
```

Agent 1.1.18 起支持手动获取服务与宿主进程资源快照：

```json
{ "type": "manage-service", "payload": { "action": "list" } }
```

- `shell` 只接受 `cmd` 或 `powershell`；脚本必须含非空白内容，长度为 1 至 32,768 个 Unicode 标量，且不得包含 NUL 或换行、制表符以外的控制字符。
- `timeoutSeconds` 为 1 至 900 的整数。超时后 Agent 终止完整进程树。
- CMD 写入受保护工作目录中的临时 `.cmd` 后由系统 `cmd.exe` 执行；PowerShell 写入临时 `.ps1` 后由内置 Windows PowerShell 以 `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File` 执行，不拼接额外 shell 参数。
- stdout 与 stderr 使用 UTF-8 有界采集，完整结果严格保持在 512 KiB UTF-8 内。结果包含 `shell`、`stdout`、`stderr`、`exitCode`、`durationMs`、`timedOut`、`truncated` 与 `error`。
- `allowCmdExecution` 与 `allowPowerShellExecution` 默认均为 `false`。旧配置缺少字段时仍保持关闭；覆盖升级保留管理员已有配置。
- 命令继续使用 journal、ACK、串行执行、WebSocket/HTTP 回退和结果重试；Agent 重启时不会重放已经开始的 `run-shell`，而是返回稳定的结构化失败。
- 面板入口位于“客户端管理 -> 批量操作 -> Windows -> 命令执行”，可受控多选在线 Windows 客户端，并通过 `/api/panel/commands/batch` 为每台客户端创建独立命令。

## `run-program` 契约

```json
{
  "type": "run-program",
  "payload": {
    "program": "C:\\Windows\\System32\\hostname.exe",
    "args": "",
    "timeoutSeconds": 60
  }
}
```

- `program` 必须是本机配置允许列表中的规范化绝对路径，匹配不区分大小写。
- 参数使用 Windows 命令行规则解析并通过 `ArgumentList` 传入，不使用 shell。
- 默认超时 300 秒，最大 900 秒，超时会终止完整进程树。
- stdout 与 stderr 合计最多 1 MiB。
- 本机程序输出默认按当前 Windows OEM 代码页读取，可通过 `outputCodePage` 覆盖。
- 结果为 JSON 字符串，包含 `stdout`、`stderr`、`durationMs`、`timedOut`、`truncated` 与 `error`。
- 命令串行执行；设备持久化后 ACK，重复投递不会重复运行。

## `manage-service` 契约

```json
{
  "type": "manage-service",
  "payload": {
    "serviceName": "ExampleService",
    "action": "restart",
    "timeoutSeconds": 60
  }
}
```

- `list` 返回全部 Windows 服务；`query` 可只读查询任意真实服务。`allowedServices` 默认为空数组，只约束 `start`、`stop`、`restart`，并按 Windows 规则进行不区分大小写的精确匹配，不支持通配符；该独立允许列表不受全局 `disableAllPolicies` 开关影响。
- `NachoAgent` 可只读查看，始终禁止启动、停止或重启自身，即使它被误加进允许列表。
- `action` 接受 `list`、`query`、`start`、`stop`、`restart`；控制超时默认 30 秒，范围为 1 至 120 秒。
- Agent 仅使用本机 `System.ServiceProcess.ServiceController` API，不执行 shell、PowerShell 或 `sc.exe`，也不接受远程机器名。
- `start` 与 `stop` 对已处于目标状态的服务幂等成功；`restart` 在停止成功后再启动。
- 单项 `result` 是 JSON 字符串，包含 `serviceName`、`action`、`initialStatus`、`finalStatus`、`durationMs`、`timedOut` 与 `error`；该命令没有伪造退出码。
- 清单 `result` 包含采集时间、采样耗时、总数、返回数、截断标记和服务数组；每项包含服务名、显示名称、状态、PID、控制策略、共享宿主标记以及 CPU、工作集、专用内存。CPU 采样约 750 ms，共享 PID 的资源值代表整个宿主进程，不是单项服务的独占值。
- 清单按服务名稳定排序，结果接近 480 KiB 时整行截断，并始终低于服务端 512 KiB 上限。
- 面板入口位于“客户端管理 -> 批量操作 -> Windows -> 服务控制”，下发前会确认目标、服务名、动作和超时，并持续读取真实命令状态与结构化结果。

新安装生成的 `%ProgramData%\Nacho\agent.json` 包含 `"allowedServices": []`。管理员应在目标机器上把允许控制的真实服务名称写入该数组并重启 `NachoAgent`；覆盖升级只更新 `serverUrl`，保留现有允许列表与其他管理员配置。

真实集成验收必须使用专门创建或明确选定的非关键测试服务：记录原状态，依次验证 `query/start/stop/restart`，最后恢复原状态。不得使用关键系统服务或 `NachoAgent`。执行验收的终端需要管理员令牌；普通终端只能运行替身状态机单元测试。

## `list-processes` 契约

Agent 1.1.19 起支持手动获取全部可见 Windows 进程：

```json
{
  "type": "list-processes",
  "payload": {}
}
```

- 该命令只接受严格空对象并仅支持单个 Windows 客户端；它复用通用命令、journal、ACK、WebSocket/HTTP 回退和结果重试链路。
- Agent 使用 `System.Diagnostics.Process` 枚举进程并进行约 750 ms 的 CPU 双点采样，不执行 shell、PowerShell、WMI 或外部命令。
- 每项包含 PID、进程名、可读取时的绝对映像路径、启动时间、会话、CPU、工作集、专用内存、效能模式，以及根据 PID 4、Agent 自身、路径可读性和 `allowedProcessPaths` 计算的终止、重启与效能模式能力。
- 访问受限的行仍保留基础信息；面板允许选择任何返回行，最终终止仍由 `terminate-process` 重新校验 PID、路径、启动时间和本机策略。
- 清单按进程名和 PID 稳定排序，接近 480 KiB 时按完整行截断，始终低于服务端 512 KiB 上限；服务日志只记录数量、截断标志和结果字节数。
- 面板入口位于“客户端管理 -> 进程终止”；用户手动点击“获取进程/刷新进程”，搜索或排序后点选一行回填 PID 与映像路径，不自动刷新。

Agent 1.1.20 起，桌面进程行右键菜单和移动端 `…` 菜单提供：

- **终止进程**：复用 `terminate-process`，固定只终止当前 PID，并带上清单的 `expectedStartedAtUtc` 防止 PID 复用；完整进程树终止仍使用原页面表单。
- **重启进程**：仅支持当前活动交互用户会话中的普通进程。Agent 读取原命令行、保留参数，通过 `CreateProcessAsUser` 在原会话启动；会话 0、系统进程、Agent 自身或上下文不可读时禁用。
- **效能模式**：通过 `GetProcessInformation` / `SetProcessInformation(ProcessPowerThrottling)` 切换 EcoQoS，并在启用时使用低优先级。Agent 保存原优先级，关闭时恢复；外部开启且没有原记录时仅清除 EcoQoS。
- `restart-process` 使用 DPAPI `LocalMachine` 保护 `%ProgramData%\Nacho\process-restarts\<commandId>.dat` 中的启动上下文，按阶段恢复且不会在未知启动状态下重复拉起进程。
- 新动作只支持单个 Windows 客户端，不加入批量命令；服务端日志只记录动作、路径哈希和结果大小，不记录命令行、用户名或完整路径。

## `terminate-process` 契约

```json
{
  "type": "terminate-process",
  "payload": {
    "processId": 1234,
    "expectedPath": "C:\\Program Files\\Example\\worker.exe",
    "timeoutSeconds": 30,
    "killProcessTree": true
  }
}
```

- `allowedProcessPaths` 默认为空数组，每一项必须是规范化绝对可执行文件路径，并按 Windows 规则进行不区分大小写的精确匹配；目录、文件名和通配符不产生匹配。
- `processId` 必须是正整数；PID 0、PID 4 与当前 `NachoAgent` 进程始终被拒绝。
- `expectedPath` 与从目标进程读取的真实映像路径必须同时命中同一允许项，且终止前会再次比较 PID、启动时间和映像路径以检测 PID 复用。
- `expectedStartedAtUtc` 为可选快照身份字段；右键菜单始终提供该字段，手工表单保持向后兼容。
- `timeoutSeconds` 默认 30 秒，范围为 1 至 120 秒；`killProcessTree` 默认 `true` 且只接受布尔值。
- Agent 仅使用本机 `System.Diagnostics.Process` API，不执行 shell、PowerShell、`taskkill.exe` 或 WMI，也不接受远程机器名。
- 目标身份确认前消失会失败；身份确认后自然退出按幂等成功处理；访问拒绝、身份变化、API 异常与超时均报告 `failed`。
- 树终止调用 `.Kill(entireProcessTree: true)`，成功条件仍是根目标进程已经退出；专用集成测试同时验证子进程退出和无关同名进程存活。
- `result` 是 JSON 字符串，包含 `processId`、`expectedPath`、`actualPath`、`killProcessTree`、`initialStatus`、`finalStatus`、`durationMs`、`timedOut` 与 `error`，该命令不提供退出码。
- 面板入口位于“客户端管理 -> 批量操作 -> Windows -> 进程终止”，下发前会重新核对客户端在线状态并确认目标、PID、路径、树终止选项和超时。

新安装生成的 `%ProgramData%\Nacho\agent.json` 包含 `"allowedProcessPaths": []`。管理员应写入允许终止的完整映像路径并重启 `NachoAgent`；覆盖升级只更新 `serverUrl`，保留该允许列表和其他管理员配置。

自动化与真实验收使用 `server/client/tests/Nacho.Agent.TestProcess` 生成的无副作用等待进程及其子进程。测试必须记录 PID 和真实映像路径，并确认单进程模式、进程树模式以及无关同名实例隔离，禁止选择系统关键进程、面板服务端或 `NachoAgent`。

## `restart-system` 契约

```json
{
  "type": "restart-system",
  "payload": {
    "delaySeconds": 30,
    "reason": "Nacho administrator requested restart"
  }
}
```

- `allowSystemRestart` 默认为 `false`；只有管理员在目标 Agent 配置中显式改为 `true` 并重启服务后，本机系统重启策略才会开启。
- payload 只接受 `delaySeconds` 与可选 `reason`；延迟必须是 0 至 300 的整数，原因最多 256 个 Unicode 字符且不得包含控制字符或换行。
- Agent 使用 Windows `InitiateSystemShutdownExW` 本机 API，显式启用并恢复 `SeShutdownPrivilege`，固定执行计划内重启且不强制关闭应用；不调用 shell、PowerShell、`shutdown.exe`、WMI 命令行或第三方工具。
- 调用系统 API 前，Agent 会把 `prepared -> requested` 意图原子写入 `%ProgramData%\Nacho\restart-intent.json`，验证期限为请求时间加延迟再加 120 秒。
- 重启前命令上报 `running` 与 `phase=requested`；最终 `success` 只由重启后的 Agent 核对 Windows 启动标识变化后上报，标识不变、过期、权限失败、API 拒绝、意图损坏与冲突均上报 `failed`。
- 同一时刻只保留一个活动重启意图；同 ID 重投幂等恢复，其他重启命令立即失败，服务恢复与结果重试不会再次触发重启 API。
- `result` 是 JSON 字符串，包含 `delaySeconds`、`reason`、`requestedAt`、`previousBootId`、`currentBootId`、`phase`、`durationMs`、`verifiedAfterRestart` 与 `error`，该命令始终没有退出码。
- 面板入口位于“客户端管理 -> 批量操作 -> Windows -> 系统重启”，只列出在线 Windows 客户端，并在高风险确认后重新核对目标在线状态再下发。

新安装生成的 `%ProgramData%\Nacho\agent.json` 包含 `"allowSystemRestart": false`。覆盖升级保留已有值；真实验收应先保存工作、确认 Agent 自动启动与服务端可达，并明确批准本机重启。

## `collect-logs` 契约

```json
{
  "type": "collect-logs",
  "payload": {
    "sources": ["agent", "system", "application"],
    "sinceUtc": "2026-07-24T07:00:00Z",
    "untilUtc": "2026-07-24T08:00:00Z",
    "maxEntries": 200
  }
}
```

- `allowLogCollection` 默认为 `false`；管理员必须在目标 Agent 配置中显式设为 `true` 并重启服务，旧配置缺少该字段时仍保持关闭，覆盖升级保留管理员值。
- payload 只接受以上四个字段；`sources` 是由 `agent`、`system`、`application` 组成的非空无重复白名单，UTC 窗口必须以 `Z` 结尾、开始早于结束、跨度不超过 24 小时且不在未来，`maxEntries` 为 1 至 1000 的整数。
- `agent` 固定读取 `%ProgramData%\Nacho\agent-diagnostics.jsonl`，另外两项只使用 .NET Windows Event Log API 读取本机 `System` 与 `Application`；payload 不接受路径、通道名、XPath、通配符、编码或远程主机。
- 消息会移除 NUL 与危险控制字符，统一换行，遮盖 Authorization、Bearer、API Key、设备令牌、密码和 secret 形态，并按 4096 个 Unicode 标量截断。
- 所有来源按 UTC 时间、来源顺序与稳定字段确定排序，单个坏事件只计数跳过；总条数按 `maxEntries` 截断，完整结果 JSON 的 UTF-8 大小不超过 512 KiB。
- `result` 完整包含 `sources`、请求/有效 UTC 窗口、`entries`、`countsBySource`、`truncated`、`durationMs` 与净化后的 `error`，每条记录包含 `source`、`timestampUtc`、`level`、`eventId`、`provider`、`message`，该命令始终没有退出码。
- Agent 日志由固定位置的内置 JSONL provider 写入；事件读取权限失败、文件缺失、坏事件和部分来源失败只返回稳定摘要，不返回原始异常、ACL、注册表、令牌或敏感正文。
- 命令继续使用现有 journal、ACK、串行队列、重复投递去重、WebSocket/HTTP 回退及结果重试；同一命令 ID 的完成结果不会重新扫描日志。
- 面板入口位于“客户端管理 -> 批量操作 -> Windows -> 日志采集”，只列出在线 Windows 客户端，提供来源、UTC 窗口和条数输入，并严格解析结果、显示计数/截断/错误与可键盘访问的响应式日志表格。

新安装生成的 `%ProgramData%\Nacho\agent.json` 包含 `"allowLogCollection": false`。真实验收应先验证策略关闭错误，再备份配置并临时开启策略，只选择很短时间窗和少量非敏感事件；完成后恢复原配置并核对 SHA-256。

## `install-package` 契约

```json
{
  "type": "install-package",
  "payload": {
    "artifactId": "artifact-0123456789ab",
    "fileName": "package.msi",
    "sha256": "64-lowercase-hex",
    "sizeBytes": 123,
    "installerType": "msi",
    "arguments": ["PROPERTY=value"],
    "successExitCodes": [0, 3010],
    "timeoutSeconds": 1800
  }
}
```

- `allowPackageInstall` 默认 `false`；管理员显式开启并重启 Agent 后才接受安装命令，覆盖升级保留已有值。
- 软件包只从受设备 token、客户端、commandId 与 artifact 四重绑定的 `/agent/managed-artifacts/:artifactId?commandId=...` 下载；不复用公开 Agent 更新地址。
- 下载目录为 `%ProgramData%\Nacho\packages\<commandId>\`。Agent 先核对声明大小与 SHA-256，再启动安装器；结束后清理包、intent 和临时文件。
- MSI 固定调用系统 `msiexec.exe /i <package> /qn /norestart`，仅追加经过校验的 `PROPERTY=value` 数组；成功码固定包含 0 和 3010，3010 返回 `rebootRequired: true`，但 Agent 不主动重启。
- EXE 直接执行下载文件，参数逐项加入 `ArgumentList`，不拼接 shell 命令；成功码固定包含 0，可由仓库元数据增加其他代码。
- 安装超时为 60–7200 秒；超时终止完整进程树。结果包含 `phase`、`downloadedBytes`、`hashVerified`、`installerType`、`exitCode`、`rebootRequired`、`durationMs`、`timedOut` 与 `error`。
- intent 会保存下载、校验、启动和进程身份。下载/校验阶段可在 Agent 重启后重新下载；已经启动的安装器只按 PID、路径和启动时间恢复等待，进程身份丢失时返回“状态未知”，绝不重复启动。
- 面板入口位于“客户端管理 -> 批量操作 -> Windows -> 批量安装”，软件仓库上传、批次创建、逐客户端进度和刷新恢复均读取真实服务端状态。

## `deploy-file` 与 `rollback-file-deploy` 契约

```json
{
  "type": "deploy-file",
  "payload": {
    "artifactId": "artifact-0123456789ab",
    "fileName": "config.json",
    "sha256": "64-lowercase-hex",
    "sizeBytes": 123,
    "destinationPath": "C:\\Deploy\\config.json",
    "conflictPolicy": "fail",
    "createDirectories": false
  }
}
```

回滚 payload 严格为 `{ "originalCommandId": "cmd-0123456789ab" }`。未知、重复、缺失或类型错误字段均返回结构化失败。

- `allowedDeployRoots` 默认为空，等价于文件下发关闭；目标必须是允许根目录内部的本地盘绝对文件路径。Agent 拒绝相对路径、UNC、设备路径、通配符、ADS、目录目标、盘符根和目录逃逸，并使用相对路径边界比较防止 `C:\Root2` 命中 `C:\Root`。
- `fileDeployBackupRetentionDays` 默认为 7。下载先进入 `%ProgramData%\Nacho\file-deployments\<commandId>\`，校验声明大小与 SHA-256 后再写入目标。
- `fail` 在目标已存在时稳定失败；`replace` 先把旧文件移动到受保护备份，再原子移动已校验文件。父目录仅在 `createDirectories: true` 时创建。
- intent 保存命令、目标、暂存、备份、前后哈希和阶段。Agent 重启后会重新开始尚未应用的下载、确认已经应用的目标哈希，或恢复备份并返回稳定失败，不重复执行破坏性步骤。
- 回滚要求备份仍存在且当前目标 SHA-256 仍等于该次下发结果；文件被后续人工修改时拒绝覆盖。成功回滚返回恢复后的 SHA-256，并使备份失效；中断的回滚按 intent 完成或恢复当前文件。
- `deploy-file` 结果包含下载字节数、哈希状态、目标、冲突策略、替换/备份状态、前后 SHA-256、耗时和净化错误；`rollback-file-deploy` 返回原命令 ID、目标、备份状态、恢复 SHA-256 和错误。服务日志不记录文件正文。
- 面板入口位于“客户端管理 -> 批量操作 -> Windows -> 文件下发”，提供真实文件选择/拖放、上传进度、在线目标多选、目标路径、目录开关、冲突确认、批次刷新恢复、逐客户端结果及防重复回滚。

## `manage-local-user` 契约

```json
{
  "type": "manage-local-user",
  "payload": {
    "action": "list",
    "userName": null,
    "groupName": null
  }
}
```

- action 仅为 `list`、`enable`、`disable`、`delete`、`add-to-group`、`remove-from-group`。三个 payload 字段始终存在；不适用字段必须为 `null`，未知、重复、缺失、超长、控制字符、域名或歧义名称均失败。
- Agent 使用 NetAPI/Win32 API 枚举和修改本地 SAM 账户，不启动 PowerShell、cmd 或其他 shell。`list` 不枚举域账户，按账户名稳定排序，并返回 SID、启用状态、内置标记和本地组。
- `allowLocalUserManagement` 默认 `false`，`allowedLocalUsers` 与 `allowedLocalGroups` 默认空。写操作必须同时命中总开关与大小写不敏感的精确允许项；读取列表不旁路到远程域。
- RID 500、501、503、504 的内置/系统账户按 SID 保护，不依赖本地化显示名。启用、禁用、加入组、移出组均幂等，重复状态返回 `changed:false`；删除不存在账户同样稳定成功且 `changed:false`。
- 已进入 running 的删除命令在 Agent 重启后返回 `AGENT_RESTARTED`，不再执行；completed 结果只重试上报。结果严格为 list 的 `accounts` 或写操作的 `target`，并包含 action、changed 和结构化 error，完整 JSON 限制在 512 KiB UTF-8 内。
- 新安装配置会写入三个策略字段；覆盖升级只更新连接信息并保留现有 `agent.json`。面板不提供创建账户、设置密码或远程改密入口。

## `manage-registry` 契约

```json
{
  "type": "manage-registry",
  "payload": {
    "action": "set",
    "hive": "HKLM",
    "view": "registry64",
    "subKey": "SOFTWARE\\Vendor\\Product",
    "valueName": "Enabled",
    "valueKind": "dword",
    "value": 1
  }
}
```

- action 仅为 `list|get|set|delete`，七个字段始终存在；list 的三个值字段均为 `null`，get/delete 的 `valueKind` 与 `value` 为 `null`。仅支持 HKLM/HKU 与 Registry32/Registry64，不读取 LocalSystem 的 HKCU。
- `allowedRegistryPaths` 默认空，等价于注册表功能关闭；条目格式为 `HKLM\...` 或 `HKU\...`。Agent 规范化路径并按完整段做大小写不敏感前缀匹配，拒绝空根、双分隔、父目录段、歧义路径及相邻同名前缀。
- Agent 直接使用 `Microsoft.Win32.RegistryKey`，不调用 PowerShell、cmd 或 reg.exe。set 可创建允许前缀内的键并在写前读取旧值；delete 只删除值。相同值 set 和删除不存在值返回 `changed:false`。
- 类型映射为 String、ExpandString、DWord、QWord、MultiString、Binary。字符串拒绝控制字符，DWORD/QWORD 检查范围，binary 检查规范 Base64；执行前后都检查 64 KiB 单值上限，完整结果检查 512 KiB。
- list/get 返回真实值与类型；set/delete 返回 `previous`、`current`、changed 和结构化 error。running 写操作遇到 Agent 重启时返回稳定失败并停止重放；completed 结果只重试上报。
- 新安装配置生成 `allowedRegistryPaths: []`；旧配置缺少字段时保持空列表，覆盖升级保留管理员原配置。面板回滚通过普通严格 set/delete 命令完成，不存在专用旁路接口。

## `show-message` 契约

```json
{
  "type": "show-message",
  "payload": {
    "title": "Test notification",
    "message": "Synthetic fixture message",
    "severity": "warning",
    "timeoutSeconds": 60,
    "expiresAt": "由服务端生成的 UTC ISO-8601"
  }
}
```

- 从 Agent 1.1.7 起，新安装配置默认写入 `allowMessagePush: true`。1.1.7 首次启动会对既有数据目录执行一次迁移：备份原 `agent.json`、把该字段设为 `true`，并写入 `message-push-policy-v1.migrated.json`；迁移标记存在后不再强制覆盖，管理员后续仍可显式关闭。安装脚本在新装和覆盖部署时都明确启用该字段，迁移服务端并保留 `%ProgramData%\Nacho` 时策略继续有效。
- `ActiveUserSessionResolver` 只考虑 Active 会话，优先当前活动控制台；控制台缺失时按 session ID 稳定选择活动 RDP 会话。结果和日志不包含用户名。
- Agent 使用 `WTSSendMessageW` 与 OK/Cancel 原生对话框，根据 severity 映射信息、警告和错误图标。响应映射为 `confirmed`、`canceled` 或 `timed-out`；无会话、策略关闭、过期与 Win32 错误为结构化失败。
- 投递前写入不含正文的 message intent，投递后标记 delivered。已进入投递的命令在 Agent 重启或重复调用时返回稳定失败，不再弹出同一消息。
- result 仅包含 `sessionId`、`deliveryStatus`、`responseCode`、`timedOut`、`durationMs` 和 `error`。成功只表示 WTS 投递/响应，不代表用户阅读、理解或接受消息内容。
- 自动迁移的原配置备份为 `%ProgramData%\Nacho\agent.json.before-message-push-enable.bak`；它继承受保护数据目录的 ACL，可用于精确回滚。配置正文、设备状态和 token 不进入 Agent 日志或面板结果。

## `open-url` 契约

```json
{
  "type": "open-url",
  "payload": {
    "url": "https://example.com/path",
    "expiresAt": "由服务端生成的 UTC ISO-8601"
  }
}
```

- URL 为 1–2048 字符的绝对 HTTP/HTTPS 地址，必须带 host 且不得含控制字符或 userinfo；payload 只含 `url` 与服务端生成的 `expiresAt`，未知、缺失或重复字段返回 `INVALID_PAYLOAD`。
- 打开网页不再设置本机总开关、scheme 允许列表或 host 允许列表；通过严格 payload 校验的绝对 HTTP/HTTPS URL 会直接进入活动用户会话启动流程。
- Agent 复用 `ActiveUserSessionResolver`，通过 `WTSQueryUserToken`、`DuplicateTokenEx`、`CreateEnvironmentBlock` 和 `CreateProcessAsUserW` 在活动用户桌面启动系统 `explorer.exe`；URL 作为单独参数进入经过 Windows 引号规则编码的命令行，不经过 cmd、PowerShell 或 Session 0。
- 启动前写入不含 URL 的 `open-url-intents/<commandId>.json`；intent 已存在或 running 命令遇到 Agent 重启时返回稳定失败，避免重复打开。
- result 仅包含 `sessionId`、`processStarted`、`pid`、`durationMs`、`expired` 与 `error`，不包含用户名、token、环境变量、完整命令行或 URL。`processStarted:true` 只证明浏览器启动请求成功，不声明页面已经加载。
- 新安装配置不再生成打开网页策略字段；1.1.15 首次启动会备份旧 `agent.json`、物理删除三个遗留字段并写入 `open-url-policy-v1.removed.json`。备份为 `agent.json.before-open-url-policy-removal.bak`，后续启动不会重复迁移。

## 当前边界

当前不包含 Linux/ARM64 包安装、包依赖编排、安装后的自动系统重启、用户交互式安装器、任意脚本安装器、远程机器关机/休眠/注销、任意文件读取、Security/PowerShell 操作日志、实时订阅、日志删除或导出包。
