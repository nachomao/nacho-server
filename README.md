# Nacho 服务端（Control Server）

三层架构中的**核心控制节点**。它是唯一的持久化与调度中心：

```
┌───────────┐      面板 API Key       ┌────────────────┐     客户端令牌 / WS      ┌───────────┐
│   面板     │  ───────────────────▶  │    服务端       │  ◀───────────────────▶  │  客户端    │
│  (Web UI) │  ◀───────────────────  │ (本项目/本目录) │                          │  (Agent)  │
└───────────┘   概览/客户端/任务/日志   └────────────────┘   注册/心跳/拉取/上报     └───────────┘
                  /插件/健康/设置            SQLite
```

- **面板** 只是前端 UI，不存任何业务数据，全部通过 `/api/panel/*` 读写服务端。
- **服务端**（本目录）负责：存储业务数据、管理客户端注册与在线状态、为面板提供 API、把任务/指令**下发**到客户端、接收并记录执行结果。
- **客户端 Agent** 通过 `/agent/*` 注册、上报心跳与指标、拉取待执行指令、回报结果，并可用 WebSocket 保持长连接以实时接收下发。

Linux 上只运行一个 `control-server` 进程与 systemd 单元。Windows Agent 的安装脚本、版本清单和 exe 下载都是该服务的内置 HTTP 路由，共用同一地址和端口，不存在单独的部署服务端。

技术栈：Node.js (>=22) + Express + `node:sqlite`（Node 内置，**无需原生编译**）+ `ws` + zod。

---

## 目录结构

```
server/
├── src/
│   ├── index.ts            # 入口：Express + HTTP + WebSocket + 离线扫描
│   ├── config.ts           # 环境变量配置
│   ├── types.ts            # 全站类型定义
│   ├── db/index.ts         # SQLite 建表与连接（node:sqlite）
│   ├── lib/                # auth 鉴权、http 助手、id、logger
│   ├── routes/
│   │   ├── panel.ts        # 面板 API（/api/panel/*）
│   │   └── agent.ts        # 客户端 API（/agent/*）
│   ├── services/           # 业务逻辑（clients/tasks/commands/logs/plugins/health/settings/overview/realtime）
│   ├── ws.ts               # 客户端 WebSocket 长连接
│   └── scripts/seed.ts     # 演示数据
├── deploy/
│   ├── install.sh          # 一键部署（Ubuntu/Debian/CentOS）
│   └── uninstall.sh        # 卸载
├── .env.example
└── package.json
```

---

## 快速开始（开发）

```bash
cd server
cp .env.example .env      # 按需修改密钥与端口
npm install
npm run seed              # 可选：写入演示数据
npm run dev               # 热重载启动，默认 http://localhost:8443
```

生产本地运行：

```bash
npm run build && npm start
```

---

## 一键部署到服务器

支持 Ubuntu / Debian / CentOS / RHEL / Rocky / AlmaLinux / Fedora。脚本会自动安装 Node、创建系统用户、编译代码、生成随机密钥、安装并启动 systemd 服务、放行防火墙端口。

部署脚本会校验并复制 `artifacts/windows` 与 `deploy/windows`，因此 Linux 服务端安装完成后会同时提供 `irm http://SERVER:PORT/install.ps1 | iex`。发布服务端前应先运行 `server/client/deploy/publish.ps1` 生成并校验 Windows Agent 制品。

```bash
cd server
sudo ./deploy/install.sh
```

自定义参数（均可选，密钥留空则自动生成）：

```bash
sudo PORT=8443 \
     PANEL_API_KEY=你的面板密钥 \
     ENROLLMENT_KEY=你的入网密钥 \
     ./deploy/install.sh
```

部署完成后脚本会打印面板 API Key、入网密钥、健康检查地址与常用运维命令。

Windows 安装器会将完整日志保存到 `%ProgramData%\Nacho\install.log`，并等待设备注册成功后才报告安装完成；关闭开放入网时，输入的 Enrollment key 必须与本目录 `.env` 中的 `ENROLLMENT_KEY` 完全一致。

常用运维：

```bash
systemctl status control-server      # 查看状态
journalctl -u control-server -f      # 实时日志
systemctl restart control-server     # 重启
sudo ./deploy/uninstall.sh           # 卸载（保留数据）
sudo PURGE=1 ./deploy/uninstall.sh   # 卸载并删除数据与用户
```

安装位置：代码 `/opt/control-server`，数据库 `/var/lib/control-server/control.db`，配置 `/opt/control-server/.env`。

---

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | 监听端口 | `8443` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `PANEL_API_KEY` | 面板访问 API 所需密钥（`Authorization: Bearer <key>`） | 必填 |
| `ENROLLMENT_KEY` | 客户端注册入网密钥 | 必填 |
| `ALLOW_OPEN_ENROLLMENT` | 是否允许客户端免入网密钥注册 | `false` |
| `PUBLIC_BASE_URL` | 安装脚本写入的外部服务端地址，留空时使用请求地址 | 空 |
| `TRUST_PROXY` | 是否信任反向代理头以计算外部安装地址 | `false` |
| `ARTIFACTS_PATH` | Agent 发布制品目录 | `./artifacts` |
| `OFFLINE_THRESHOLD` | 超过该秒数无心跳判定为离线 | `90` |
| `DATABASE_PATH` | SQLite 文件路径 | `./data/control.db` |
| `CORS_ORIGIN` | 允许的面板来源，`*` 或逗号分隔 | `*` |

---

## 鉴权模型

- **面板 → 服务端**：所有 `/api/panel/*` 请求需带 `Authorization: Bearer <PANEL_API_KEY>`。
- **客户端注册**：`POST /agent/enroll` 需在 body 中带 `enrollmentKey`；成功后返回**一次性客户端令牌 `token`**，客户端须自行持久化。
- **客户端 → 服务端**：注册之后的所有 `/agent/*` 请求需带 `Authorization: Bearer <token>`。

---

## API 一览

### 面板 API（`/api/panel`，需面板密钥）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/overview` | 首页概览统计 |
| GET | `/clients` | 客户端列表（含实时在线状态） |
| GET/POST/PATCH/DELETE | `/clients[/:id]` | 客户端增删改查 |
| POST | `/clients/:id/commands` | 向单台客户端下发一次性指令 |
| GET | `/commands?clientId=` | 指令记录 |
| GET/POST/DELETE | `/groups[/:name]` | 客户端分组 |
| GET/POST/PATCH/DELETE | `/tasks[/:id]` | 计划任务增删改查 |
| POST | `/tasks/:id/enabled` | 启用/停用任务 |
| POST | `/tasks/:id/dispatch` | **把任务下发到目标客户端**（核心链路） |
| GET/DELETE | `/logs`，`/logs/sources` | 日志查询与清空 |
| GET/POST/PATCH/DELETE | `/plugins[/:id]` | 插件管理，`/:id/status` 改状态 |
| GET | `/health/findings`、`/health/packages`、`/health/stats` | 健康监控 |
| POST | `/health/findings/:id/read`、`/health/findings/read-all` | 标记已读 |
| GET/PUT | `/settings` | 系统设置读写 |

### 客户端 API（`/agent`）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/enroll` | 入网密钥 | 注册并领取令牌 |
| POST | `/heartbeat` | 令牌 | 上报心跳与指标，返回待执行指令数 |
| GET | `/commands/pending` | 令牌 | 拉取待执行指令（轮询回退） |
| POST | `/commands/:id/report` | 令牌 | 上报指令执行结果 |
| POST | `/findings` | 令牌 | 上报健康发现 |
| WS | `/agent/ws?token=<token>` | 令牌 | 长连接，实时接收下发指令 |

Windows Agent 安装与制品接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/install.ps1` | 按当前服务端地址动态生成 Windows 安装脚本 |
| GET | `/uninstall.ps1` | Windows 卸载脚本 |
| GET | `/agent/downloads/windows/latest.json` | 当前 Windows Agent 版本与 SHA-256 清单 |
| GET | `/agent/downloads/windows/:file` | Windows Agent 单文件制品 |
| POST | `/agent/commands/:id/ack` | 客户端持久化指令后的确认接口 |

WebSocket 同时接受 `Authorization: Bearer <token>` 与旧版 query token；新客户端使用 Authorization 头。

---

## 核心链路示例

```bash
BASE=http://SERVER:8443
PANEL_KEY=面板密钥
ENROLL_KEY=入网密钥

# 1) 客户端注册领取令牌
TOKEN=$(curl -s -X POST $BASE/agent/enroll \
  -H 'content-type: application/json' \
  -d "{\"enrollmentKey\":\"$ENROLL_KEY\",\"name\":\"web-01\",\"os\":\"Linux\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.token')

# 2) 面板下发一次性指令
curl -s -X POST $BASE/api/panel/clients/<clientId>/commands \
  -H "authorization: Bearer $PANEL_KEY" -H 'content-type: application/json' \
  -d '{"type":"run-program","payload":{"program":"echo","args":"hi"}}'

# Windows CMD / Windows PowerShell 批量执行；服务端去重并校验所有目标均为 Windows
curl -s -X POST $BASE/api/panel/commands/batch \
  -H "authorization: Bearer $PANEL_KEY" -H 'content-type: application/json' \
  -d '{"clientIds":["<clientId>"],"type":"run-shell","payload":{"shell":"cmd","script":"ver","timeoutSeconds":30}}'

# Windows 服务控制复用同一个通用命令接口；允许列表由目标 Agent 本机配置决定
curl -s -X POST $BASE/api/panel/clients/<clientId>/commands \
  -H "authorization: Bearer $PANEL_KEY" -H 'content-type: application/json' \
  -d '{"type":"manage-service","payload":{"serviceName":"ExampleService","action":"query","timeoutSeconds":30}}'

# Windows 进程终止同样复用通用接口，并由目标 Agent 的 allowedProcessPaths 约束
curl -s -X POST $BASE/api/panel/clients/<clientId>/commands \
  -H "authorization: Bearer $PANEL_KEY" -H 'content-type: application/json' \
  -d '{"type":"terminate-process","payload":{"processId":1234,"expectedPath":"C:\\Program Files\\Example\\worker.exe","timeoutSeconds":30,"killProcessTree":true}}'

# Windows 系统重启复用通用接口，并由目标 Agent 的 allowSystemRestart 本机策略约束
curl -s -X POST $BASE/api/panel/clients/<clientId>/commands \
  -H "authorization: Bearer $PANEL_KEY" -H 'content-type: application/json' \
  -d '{"type":"restart-system","payload":{"delaySeconds":30,"reason":"Nacho administrator requested restart"}}'

# Windows 日志采集仍复用通用接口，并由 allowLogCollection 与固定来源白名单约束
curl -s -X POST $BASE/api/panel/clients/<clientId>/commands \
  -H "authorization: Bearer $PANEL_KEY" -H 'content-type: application/json' \
  -d '{"type":"collect-logs","payload":{"sources":["agent","system","application"],"sinceUtc":"2026-07-24T07:00:00Z","untilUtc":"2026-07-24T08:00:00Z","maxEntries":200}}'

# Windows 本地账户查询；所有 payload 固定包含 action/userName/groupName
curl -s -X POST $BASE/api/panel/clients/<clientId>/commands \
  -H "authorization: Bearer $PANEL_KEY" -H 'content-type: application/json' \
  -d '{"type":"manage-local-user","payload":{"action":"list","userName":null,"groupName":null}}'

# 3) 客户端拉取待执行指令
curl -s $BASE/agent/commands/pending -H "authorization: Bearer $TOKEN"

# 4) 客户端回报结果
curl -s -X POST $BASE/agent/commands/<cmdId>/report \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"status":"success","result":"hi","exitCode":0}'
```

面板前端只需把请求指向本服务端的 `/api/panel/*` 并带上面板 API Key 即可打通全链路。

## Windows 软件仓库与批量安装

- `POST /api/panel/managed-artifacts` 创建 package/file 草稿；`PUT /api/panel/managed-artifacts/:id/content` 要求 `application/octet-stream` 与 `Content-Length`，边读边计算 SHA-256，完成后原子改名为 ready。软件包上限 1 GiB，普通文件上限 512 MiB。
- `GET /api/panel/managed-artifacts` 读取仓库；`DELETE /api/panel/managed-artifacts/:id` 在存在 pending/sent/running 命令时返回冲突。终态删除会移除正文并隐藏元数据，但保留 deleted 元数据、命令 payload 和批次历史。
- `POST /api/panel/package-deployments` 接收无重复的 artifactIds、在线 Windows clientIds 与 60–7200 秒超时，并创建“包数 × 客户端数”的 `install-package` 命令矩阵。
- `GET /api/panel/deployment-batches/:id` 返回逐项命令、客户端、制品和状态；`GET /api/panel/deployment-batches?kind=package&limit=1` 用于页面刷新后恢复最近批次。
- `GET /agent/managed-artifacts/:artifactId?commandId=:commandId` 使用设备 token，并同时校验客户端、命令、deployment item、活动命令状态和 ready artifact；公开 `/agent/downloads/windows/*` 仍只服务 Agent 自升级。
- 增量初始化创建 `managed_artifacts`、`deployment_batches`、`deployment_items`，可在旧库及重复启动上执行。
- 安装结果和服务日志分离：完整结构化结果只在命令记录中，服务日志仅保存 resultBytes 与 exitCode，不复制参数、包正文或结果正文。

## Windows 文件下发与回滚

- `POST /api/panel/file-deployments` 接收一个 ready file artifact、无重复的在线 Windows `clientIds`、绝对 `destinationPath`、`fail|replace` 冲突策略和 `createDirectories`，为每台目标创建独立 `deploy-file` 命令并写入复用的 deployment batch/item。
- `deploy-file` payload 严格包含 `artifactId`、`fileName`、`sha256`、`sizeBytes`、`destinationPath`、`conflictPolicy` 和 `createDirectories`；文件上限为 512 MiB。通用命令接口拒绝绕过专用部署入口。
- Agent 文件下载继续使用 `/agent/managed-artifacts/:artifactId?commandId=...`，同时绑定设备 token、客户端、活动命令、deployment item 和 ready artifact；不复用公开升级下载地址。
- `POST /api/panel/clients/:clientId/file-deployments/:commandId/rollback` 只接受属于该客户端、状态为 success 且结构化结果声明有效备份的原 `deploy-file`，然后创建严格 `{ originalCommandId }` 的 `rollback-file-deploy`；同一原命令只允许一个活动或成功回滚。
- 批次通过 `GET /api/panel/deployment-batches?kind=file` 与 `GET /api/panel/deployment-batches/:id` 恢复。文件正文与完整命令结果不复制到服务日志，日志只记录类型、ID、目标数量、字节数、状态和结果字节数。

## Windows 本地用户管理

- `manage-local-user` 只通过单机通用命令入口下发给 Windows 客户端；action 为 `list|enable|disable|delete|add-to-group|remove-from-group`。payload 严格固定为 `action`、`userName`、`groupName` 三个字段：`list` 两个名称均为 `null`，启停/删除的 `groupName` 为 `null`，组操作要求两个名称。
- 用户名采用 1–20 字符 Windows 本机账户约束，组名采用 1–256 字符本地组约束；拒绝控制字符、域分隔符、歧义名称、多余或缺失字段。服务端拒绝 Linux 目标。
- `list` 结果包含稳定排序的 `userName`、SID、启用状态、内置账户标记和本地组；写结果包含 action、changed、目标快照和结构化 error。服务端对结果再次执行严格结构校验，并统一限制为 512 KiB UTF-8。
- 完整账户列表、SID 和组成员关系只保存在命令 result。创建日志只记录 action、客户端和命令 ID；结果日志只记录 action、changed、exitCode 与结果字节数。
- 面板用户管理使用在线 Windows 单选目标，刷新后从命令历史恢复最近 list；启停和组操作显示确认摘要，删除要求再次输入完整账户名，写操作成功后自动下发新的 list。

## Windows 注册表管理

- `manage-registry` 只通过单机通用命令入口下发给 Windows 客户端，action 为 `list|get|set|delete`；hive 限定 `HKLM|HKU`，view 限定 `registry64|registry32`，禁止 HKCU。payload 始终严格包含 `action`、`hive`、`view`、`subKey`、`valueName`、`valueKind`、`value` 七个字段，不适用字段必须为 `null`。
- `set` 支持 `string|expandString|dword|qword|multiString|binary`。DWORD 范围为 0..4294967295，QWORD 使用十进制字符串或安全整数并限制在有符号 64 位正数范围；binary 使用规范 Base64。任一值的 JSON 序列化上限为 64 KiB，完整命令结果仍限制为 512 KiB UTF-8。
- 服务端拒绝控制字符、空/双反斜杠、`.`/`..` 段、错误值类型、多余字段和非 Windows 目标；Agent 再次独立验证。结果 action 必须与原命令一致，success/error 与终态保持一致。
- 结果中的 `previous` 与 `current` 保留值类型和数据，供面板生成严格的逆向 `set` 或 `delete`；删除仅删除值，不递归删除键。完整值只保存在命令 payload/result，审计日志只记录 action、hive、view、路径 SHA-256 短摘要、changed 和结果字节数。
- 面板提供在线 Windows 单选、hive/view/subKey、真实值列表、按类型编辑器、Base64 解码字节数、写/删确认、刷新恢复和“回滚上次操作”；长路径和长值只在局部容器滚动。

## Windows 消息推送

- 面板通过 `POST /api/panel/commands/batch` 提交严格的 `show-message` 请求：title 为 1–128 个 Unicode 标量，message 为 1–2000 个标量，severity 为 `info|warning|error`，timeoutSeconds 为 5–300。调用方不得提交 `expiresAt`。
- 服务端为同一批次生成完全相同的 `expiresAt=创建时间+5分钟`，每台在线 Windows 客户端各创建一条命令；非 Windows、重复 ID、未知字段、控制字符和越界标量均拒绝。
- 结果严格包含 sessionId、deliveryStatus、responseCode、timedOut、durationMs 和结构化 error，不包含用户名。完整 title/message 只保存在命令 payload，日志仅保存 severity、投递状态、session ID、响应代码与结果字节数。
- `confirmed|canceled|timed-out` 表示 WTS 原生对话框的投递/响应结果；它只证明 WTSSendMessage 调用及其响应，不证明用户已经阅读或理解正文。expired、无活动会话和 Win32 错误返回结构化失败。
- 面板提供 Unicode 标量计数、级别、超时、在线 Windows 多选、确认摘要、逐客户端轮询结果和刷新恢复，不把消息草稿写入 settings。
- Agent 1.1.7 的部署配置默认启用 `allowMessagePush`；首次升级会在 Windows 数据目录中备份原配置并执行一次性迁移，之后由迁移标记保护管理员的后续显式修改。控制服务迁移到独立 Linux 时只需保留/重新注册设备连接，消息推送策略不会因服务端位置变化而恢复为关闭。

## Windows 打开网页

Agent 1.1.16 的测试配置默认设置 `disableAllPolicies:true`，统一绕过本机 allow/deny 门禁，保留协议、payload、过期时间、会话、路径和结果校验。将该字段设为 `false` 后恢复各项旧细粒度策略。

- 面板通过 `POST /api/panel/commands/batch` 提交严格 `open-url` 请求，调用方只传 `url`；服务端拒绝 `expiresAt` 注入，并为同批在线 Windows 目标生成相同的五分钟 UTC 过期时间。
- URL 最长 2048 字符，必须是带主机的绝对 HTTP/HTTPS URL；控制字符、userinfo、相对地址及 `file:`、`javascript:`、`data:` 等其他协议在面板、服务端和 Agent 三处分别校验。
- Agent 不再设置打开网页的本机策略门禁；通过三层严格校验的绝对 HTTP/HTTPS URL 会直接进入活动会话解析与启动流程。1.1.15 首次启动会备份现有配置、物理删除旧 `allowOpenUrl`/scheme/host 字段并写幂等迁移标记。
- Agent 复用活动控制台优先、RDP 稳定回退的 `ActiveUserSessionResolver`，通过 WTS 用户 token、`DuplicateTokenEx`、用户环境块与 `CreateProcessAsUserW` 在 `winsta0\default` 启动系统 `explorer.exe`，URL 作为独立参数传入，不在 Session 0 或 shell 拼接中启动。
- result 严格包含 `sessionId`、`processStarted`、`pid`、`durationMs`、`expired` 和结构化 `error`。成功文案只表示“已启动浏览器请求”，不代表页面内容已经加载。无活动会话、过期与 Win32 错误均为结构化失败。
- URL intent 在调用 Win32 前持久化；已进入启动阶段的命令遇到 Agent 重启或重复执行时不再打开同一 URL。服务日志只记录规范化 scheme/host、进程启动摘要和结果字节数，不记录 path、query、fragment 或完整 URL。

## 客户端已安装但面板未显示

Agent 首次注册成功后会立即写入 `DATABASE_PATH` 指向的 SQLite `clients` 表，面板客户端列表再通过 `GET /api/panel/clients` 读取同一份数据。

排查顺序：

1. 在 Windows 上确认 `NachoAgent` 服务正在运行，并检查 `%ProgramData%\Nacho\agent.json` 中的 `serverUrl` 是否指向当前控制服务端。
2. 确认首次安装输入的是服务端 `.env` 中的 `ENROLLMENT_KEY`；该密钥只用于 Agent 首次注册，不是面板密钥。
3. 在面板“设置 → 服务端连接”中填写控制服务端根地址以及同一服务端 `.env` 中的 `PANEL_API_KEY`，不要把浏览器所在机器的 `localhost` 当成远程 Linux 服务端。
4. 使用下面的请求直接确认数据库列表接口；401 表示 `PANEL_API_KEY` 不一致，正常响应中的 `data` 即为面板应展示的设备列表。

```bash
curl -s http://SERVER:PORT/api/panel/clients \
  -H "Authorization: Bearer $PANEL_API_KEY"
```

Windows 安装链接固定为 `http://SERVER:PORT/install.ps1`，与控制服务端共用地址和端口，不需要额外开放下载端口。

## Windows 系统重启说明

`restart-system` 仍使用通用命令创建、查询、ACK 和报告接口，服务端会保存重启前 `running/requested` 进度以及重启后 `success/verified` 或 `failed` 结果。安全策略、Windows 权限、单活动意图、启动标识核验和 120 秒验证宽限期全部由目标 Agent 执行；服务端不建立旁路队列，也不会自行推断重启成功。

新安装 Agent 的 `allowSystemRestart` 为 `false`。管理员应只在已保存工作、允许重启且确认 Agent 自动启动与服务端可达的 Windows 机器上临时开启该值，完成真实验收后恢复原配置。

## Windows 日志采集说明

`collect-logs` 使用同一套命令创建、查询、ACK、结果报告、WebSocket/HTTP 投递和 SQLite 持久化链路，服务端不读取目标日志、不建立旁路队列，也不推断采集成功。Agent 只接受 `agent`、`system`、`application` 三个固定来源、最长 24 小时窗口、1 至 1000 条记录，并把完整结果限制为 512 KiB UTF-8。

HTTP 与 WebSocket 的通用结果持久化入口都拒绝超过 512 KiB 的结果。对于 `collect-logs`，服务端业务日志只记录结果字节数，不把采集正文复制到服务端日志表；正文只保存在对应命令结果中。面板会对全部结果字段、每条记录、来源计数、控制字符和字节上限进行严格校验，畸形 JSON 只显示为未解析结果。

新安装 Agent 的 `allowLogCollection` 为 `false`，升级不会覆盖已有管理员配置。日志内容可能包含业务与设备诊断数据；管理员应选择最短必要时间窗与最少来源，避免采集凭据，并在真实验收后恢复配置。当前范围排除任意文件/通道/XPath、Security 日志、PowerShell 操作日志、远程机器、实时订阅、删除、导出包和服务端日志聚合。
