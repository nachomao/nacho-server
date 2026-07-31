# Nacho Windows Agent

Windows 客户端负责设备注册、DPAPI 设备令牌持久化、心跳与指标、WebSocket 实时接收、HTTP 轮询回退、可靠指令确认，以及受本机策略约束的程序执行、Windows 服务控制、本机进程终止与系统重启。

## 运行结构

- 目标：Windows x64，.NET 10，自包含单文件。
- 服务：`NachoAgent`，`LocalSystem`，自动延迟启动，失败自动重启。
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
irm http://SERVER:PORT/install.ps1 | iex
```

Windows PowerShell 5.1 请使用上面的 `irm` 命令；裸用 `iwr URL | iex` 可能触发旧 Internet Explorer 解析器的 `NullReferenceException`。确需使用 `iwr` 时应写成 `iwr URL -UseBasicParsing | Select-Object -ExpandProperty Content | iex`。

重复运行会停止并升级现有服务、等待旧服务进程完全退出、重试替换被短暂占用的可执行文件、更新服务器地址，并保留设备身份和管理员维护的允许列表。升级中途失败时会尝试恢复原有运行中服务。

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

- `allowedServices` 默认为空数组，只接受真实服务名称并按 Windows 规则进行不区分大小写的精确匹配，不支持通配符。
- `NachoAgent` 始终禁止控制自身，即使它被误加进允许列表。
- `action` 仅接受 `query`、`start`、`stop`、`restart`；超时默认 30 秒，范围为 1 至 120 秒。
- Agent 仅使用本机 `System.ServiceProcess.ServiceController` API，不执行 shell、PowerShell 或 `sc.exe`，也不接受远程机器名。
- `start` 与 `stop` 对已处于目标状态的服务幂等成功；`restart` 在停止成功后再启动。
- `result` 是 JSON 字符串，包含 `serviceName`、`action`、`initialStatus`、`finalStatus`、`durationMs`、`timedOut` 与 `error`；该命令没有伪造退出码。
- 面板入口位于“客户端管理 -> 批量操作 -> Windows -> 服务控制”，下发前会确认目标、服务名、动作和超时，并持续读取真实命令状态与结构化结果。

新安装生成的 `%ProgramData%\Nacho\agent.json` 包含 `"allowedServices": []`。管理员应在目标机器上把允许控制的真实服务名称写入该数组并重启 `NachoAgent`；覆盖升级只更新 `serverUrl`，保留现有允许列表与其他管理员配置。

真实集成验收必须使用专门创建或明确选定的非关键测试服务：记录原状态，依次验证 `query/start/stop/restart`，最后恢复原状态。不得使用关键系统服务或 `NachoAgent`。执行验收的终端需要管理员令牌；普通终端只能运行替身状态机单元测试。

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

## 当前边界

本阶段不包含 Linux、ARM64、MSI、自动升级、用户交互会话、后台分离进程、远程机器重启、关机、休眠、注销、任意文件读取、Security/PowerShell 操作日志、实时订阅、日志删除或导出包；日志采集只覆盖显式开启本机策略的 Windows 目标及三个固定来源。
