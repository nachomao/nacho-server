# nacho-server 项目级开发提示词（AGENTS.md）

本文件只约束 `nacho-server` 仓库（服务端 + Windows Agent）。面板前端在独立仓库 `nachomao/nacho-main`，其开发约定不在此文件范围内。

## 1. 核心原则

- 本项目处于持续开发阶段。每次任务均以当前工作区源码、配置、测试和实际运行状态为准。
- 信息优先级：当前源码与配置 > 自动化测试 > 实际运行结果 > README > 历史续作记录 > 口头推测。
- 开始修改前先读取相关文件并执行 `git status --short`；已有实现、协议、测试和运行态需要延续，避免重复实现已经闭环的功能。
- 输出与代码注释优先使用中文；类型名、协议字段、命令、日志关键字保持源码中的英文形式。
- 只陈述亲自读取或执行确认的事实。运行结果、服务状态、测试数量、制品版本和哈希均在当前任务中重新获取。
- 以最小完整改动完成任务，同时保持无关页面、协议、脚本和运行配置不变。

## 2. 仓库边界

本仓库根目录即服务端项目根目录（不是 `server/` 子目录）。包含两个可独立发布的单元：

| 目录 | 内容 | 技术栈 | 包管理器 |
|---|---|---|---|
| `src/` | 控制服务端 | Node.js >=22、Express 4、WebSocket、Zod、内置 `node:sqlite` | npm |
| `client/` | Windows Agent | .NET 10、Windows Service、自包含 `win-x64` 单文件发布 | dotnet/NuGet |

- `src/` 不得出现任何越出仓库根目录的相对引用（`../../`）。本仓库已从 `nacho-main` 拆出，任何跨仓引用都会破坏独立构建。
- 服务端与 Agent 之间只通过 HTTP/WebSocket 协议和 `artifacts/windows` 制品目录耦合，不共享源码。
- 面板不在本仓库。面板只通过 `/api/panel/*` 读写本服务端，不得让服务端反向依赖面板代码。

## 3. 真实数据流与协议边界

1. Agent 首次调用 `/agent/enroll` 注册并取得独立设备 token，之后以该 token 心跳、拉取、ACK 和上报结果。
2. 服务端把业务数据与命令状态持久化到 SQLite；在线 Agent 优先由 `/agent/ws` 接收命令，断线时由 HTTP 轮询回退。
3. 命令状态主链路为 `pending -> sent -> running -> success|failed|canceled`。Agent 先把命令写入本地 journal，再 ACK，最终结果支持断线重试与幂等恢复。
4. API 成功响应遵循 `{ "ok": true, "data": ... }`；失败响应由服务端统一错误处理返回。
5. Panel API Key、首次入网用 Enrollment Key、Agent 设备 token 是三种独立凭据，字段与使用位置保持分离。
6. `update-agent` 只能由 `/api/panel/agent-updates` 根据服务端真实发布清单生成。通用 `/clients/:id/commands` 保持对该类型的专用入口约束。
7. `result` 当前是命令表中的字符串字段；结构化结果以 JSON 字符串保存。修改字段时同步更新 Agent、服务端与测试。
8. HTTP 与 WebSocket 的结果上报保持一致的大小、状态和所有权校验；`collect-logs` 的 512 KiB UTF-8 上限不得被旁路。

## 4. 分层实现规则

### 4.1 服务端（`src/`）

- 路由层负责认证、Zod 校验和 HTTP envelope；业务规则放在 `src/services/`；SQLite 映射集中在 db/service 层。
- 数据库变更采用可重复执行的增量初始化，兼容现有 `/opt/control-server` 数据库。
- 修改命令契约时同时检查 HTTP、WebSocket、SQLite、日志裁剪、离线队列和重复投递。
- 新增写操作时记录必要的业务审计摘要，同时避免把命令完整结果、凭据或采集正文复制进服务日志。
- 保持 `.env.example` 只包含示例值。运行中的 `.env` 仅用于部署，不读取到聊天输出。

### 4.2 Agent（`client/`）

- 命令执行继续串行化，并沿用 `CommandJournal` 的先持久化、ACK、执行、报告和重试流程。
- 程序／Shell／包安装、文件部署与回滚、服务／进程／用户／注册表管理、消息／URL、系统重启和日志采集继续执行各自的本机策略、权限与允许列表；升级保留既有 `agent.json`、DPAPI 身份和 journal。
- Windows 操作优先使用现有 .NET／Win32 API，不引入额外 shell 链路。
- 受 ACL 保护的 `%ProgramData%/Nacho` 内容仅在确有验收需要时由提升后的终端读取；配置、设备 token 和 DPAPI 状态不进入输出。

### 4.3 部署脚本（`deploy/`）

- `install.sh` / `uninstall.sh` / `napl` 必须保持 **LF 行尾**（见 `.gitattributes`）。云端部署会把它们上传到 Linux 后直接交给 bash strict mode，CRLF 会导致解析失败。
- `install.sh` 只从脚本上级目录（仓库根）复制 `package.json`、`package-lock.json`、`tsconfig.json`、`src`、`deploy`、`artifacts`，不得引用仓库根以外的路径。
- `napl` 的在线升级仓库地址由 `REPO="${NAPL_GITHUB_REPO:-nachomao/nacho-server}"` 提供，下载来源白名单必须由该变量推导，不得硬编码仓库路径。
- 发布仓库地址在 `napl` 默认值、`install.sh` 的 systemd `Documentation=` 和 `package.json` 的 `repository` 三处必须一致，由 `src/tests/linux-deploy-scripts.test.ts` 断言。
- `deploy/napl-release-public.pem` 是发布 manifest 的 Ed25519 公钥。**替换它会使所有已部署实例的在线升级失效**，除非同时保留旧公钥或安排重新安装。
- `deploy/build-release.mjs` 必须在 Linux x64 上运行（Windows 走 WSL2），产出 `control-server-<version>-linux-x64.tar.gz`、`manifest.json` 和 `manifest.sig`。

### 4.4 制品策略

- `artifacts/windows/*.exe` 约 72 MB，**不入库**，由 `client/deploy/publish.ps1` 在开发机生成。
- `artifacts/evidence/` 是临时验收证据，不入库。
- `install.sh` 会校验 `artifacts/windows/latest.json` 中的 SHA-256 与实际文件是否一致，缺失或不一致即退出。发布服务端前必须先运行 `client/deploy/publish.ps1`。

## 5. 部署拓扑

同一套源码支持三种互斥选择的运行模式。**一次运行只使用一种模式**，不得因普通任务自动启动 WSL，也不得把某一模式的状态当作另一模式的状态。多种模式同机并存时必须使用不同端口。

| 模式 | 运行位置 | 安装目录 | 管理方式 | 验收命令 |
|---|---|---|---|---|
| Windows 本机部署 | 当前 Windows 设备 | 仓库内 `server/`（旧布局） | `deploy/windows/local-control-server.ps1` + 面板本机 API | `Invoke-RestMethod http://127.0.0.1:PORT/health` |
| WSL2 部署 | WSL2 `Debian` / `debian` | `/opt/control-server` | `deploy/install.sh` + `control-server.service` | `curl -fsS http://localhost:8443/health` |
| 独立 Linux 服务器 | 远程 Linux 主机 | `/opt/control-server` | `deploy/install.sh` + `control-server.service` | `curl -fsS http://127.0.0.1:PORT/health` |

- WSL/Linux 部署遵循"源码验证 → 备份运行态 → 同步部署副本 → 重启 systemd → 健康/API 验证 → 失败则回滚"。
- `/opt/control-server` 是运行副本，本仓库是源码来源。同步时保持部署侧 `.env`、SQLite 数据库和 systemd 配置原样。
- 需要提权时使用当前会话提供的 `WSL_SUDO_PASSWORD`，或由调用方显式选择 WSL root；凭据只经标准输入传递，不进入仓库、日志或摘要。

## 6. 文件与依赖管理

- 服务端使用 `package-lock.json` 与 npm，Agent 使用 dotnet/NuGet。`package-lock.json` **必须提交**，安装脚本依赖它执行 `npm ci`。
- 生成目录和运行数据保持只读：`node_modules/`、`dist/`、`data/`、`**/bin/`、`**/obj/`、`.nacho-local/`、`.nacho-runtime/`。
- `.codex-*`、`.v0-backups/`、`*.bak`、无引用的调试截图和 `artifacts/evidence/` 属于临时文件，不提交。
- 保留用户已有的未提交文件和运行数据；修改聚焦当前任务涉及的文件。
- 清理、重置、暂存、提交与推送均以用户明确要求为触发条件。

## 7. 分层验证命令

### 7.1 服务端

```bash
npm test
npm run build
```

- `server/node_modules` 若由 Windows npm 安装，其中 `esbuild` 原生包与 Linux 不兼容。WSL 测试使用 WSL 文件系统中的隔离目录：复制 `package*.json`、`tsconfig.json`、`src/`、`deploy/`，执行 `npm ci --no-audit --no-fund`、测试和构建，完成后校验临时路径位于 `/tmp/` 再清理。
- 服务端测试不直接覆盖 `/opt/control-server`。

### 7.2 Agent（在 Windows 上运行）

```powershell
dotnet test client/tests/Nacho.Agent.Tests/Nacho.Agent.Tests.csproj
dotnet build client/src/Nacho.Agent/Nacho.Agent.csproj -c Release
```

涉及发布时追加：

```powershell
powershell -ExecutionPolicy Bypass -File client/deploy/publish.ps1
```

发布后必须验证 `artifacts/windows/latest.json` 的文件名、字节数和 SHA-256 与实际文件一致。

### 7.3 部署脚本夹具

```bash
bash deploy/tests/napl-fixture.sh
```

该夹具在临时目录中用假的 `systemctl`/`curl`/`node` 验证 `napl` 的非交互命令面，可在无 root 环境下运行。

### 7.4 联调顺序

1. 当前选定模式的服务端 `/health` 返回成功；Windows 本机模式核对受管 PID，WSL/Linux 模式核对 `control-server.service`。
2. Windows `NachoAgent` 服务状态符合预期，心跳能更新客户端版本与在线状态。
3. 直接调用 Panel API 验证请求／响应和 SQLite 命令状态。
4. 验证 WebSocket 推送；断开实时通道后验证 HTTP 回退。
5. 涉及离线队列、服务重启、系统重启、日志采集或升级时，额外验证幂等、恢复与回滚。
6. 真机测试结束后恢复服务状态、配置、制品和临时夹具，清理已验证的临时目录。

## 8. 每次任务的执行与交付格式

1. **Current**：用一行写明当前对象、最近确认结果和下一动作。
2. **Inspect**：读取相关源码、测试、配置和运行态；列出真实调用链与现有边界。
3. **Implement**：直接修改必要文件，保持协议一致；工具失败后说明失败步骤并立即改用修正命令。
4. **Verify**：先做目标测试，再做受影响层的全量检查；需要联调时按第 7.4 节执行。
5. **Restore**：真机测试结束后恢复服务状态、配置、制品和临时夹具。
6. **Report**：最终摘要包含改动文件、行为变化、执行过的命令及结果、真实运行证据、剩余边界或下一步。

## 9. 动态基线规则

- 不在本文件固化测试数量、工具链版本、服务状态、制品版本或哈希；这些信息会随持续开发和部署变化。
- 每次任务按受影响层重新执行第 7 节验证，并在最终报告中记录当次命令、结果与未执行原因。
- 历史聊天、验收截图和证据目录只能用于追溯，不能替代当前源码、自动化测试和真实运行结果。
