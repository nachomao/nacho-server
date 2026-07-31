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

# 3) 客户端拉取待执行指令
curl -s $BASE/agent/commands/pending -H "authorization: Bearer $TOKEN"

# 4) 客户端回报结果
curl -s -X POST $BASE/agent/commands/<cmdId>/report \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"status":"success","result":"hi","exitCode":0}'
```

面板前端只需把请求指向本服务端的 `/api/panel/*` 并带上面板 API Key 即可打通全链路。

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
