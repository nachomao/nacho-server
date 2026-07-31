#!/usr/bin/env bash
#
# 一键部署脚本 —— 面板服务端 (control server)
# 支持：Ubuntu / Debian / CentOS / RHEL / Rocky / AlmaLinux / Fedora
#
# 用法（以 root 运行，或加 sudo）：
#   sudo ./install.sh
#   sudo PORT=8443 PANEL_API_KEY=xxx ENROLLMENT_KEY=yyy ./install.sh
#
# 该脚本会：
#   1. 检测发行版并安装 Node.js (>=22) 与依赖
#   2. 创建专用系统用户与安装目录
#   3. 复制服务端代码并安装生产依赖
#   4. 生成 .env（若缺失则自动生成安全随机密钥）
#   5. 安装并启动 systemd 服务，设置开机自启
#
set -euo pipefail

# ---------------------------------------------------------------------------
# 可通过环境变量覆盖的配置
# ---------------------------------------------------------------------------
APP_NAME="${APP_NAME:-control-server}"
APP_USER="${APP_USER:-control}"
INSTALL_DIR="${INSTALL_DIR:-/opt/${APP_NAME}}"
DATA_DIR="${DATA_DIR:-/var/lib/${APP_NAME}}"
NODE_MAJOR="${NODE_MAJOR:-22}"
PORT="${PORT:-8443}"
HOST="${HOST:-0.0.0.0}"
OFFLINE_THRESHOLD="${OFFLINE_THRESHOLD:-90}"
ALLOW_OPEN_ENROLLMENT="${ALLOW_OPEN_ENROLLMENT:-false}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
TRUST_PROXY="${TRUST_PROXY:-false}"

# 密钥：未提供则生成随机值
PANEL_API_KEY="${PANEL_API_KEY:-}"
ENROLLMENT_KEY="${ENROLLMENT_KEY:-}"

# 脚本所在目录（server/deploy），其上级即 server 源码根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

log()  { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    err "请以 root 运行（或使用 sudo）。"
    exit 1
  fi
}

gen_key() {
  # 优先用 openssl，退化到 /dev/urandom
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# ---------------------------------------------------------------------------
# 发行版检测
# ---------------------------------------------------------------------------
detect_os() {
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_LIKE="${ID_LIKE:-}"
  else
    err "无法读取 /etc/os-release，暂不支持该系统。"
    exit 1
  fi

  case "${OS_ID}${OS_LIKE}" in
    *debian*|*ubuntu*) PKG_FAMILY="debian" ;;
    *rhel*|*centos*|*fedora*|*rocky*|*almalinux*) PKG_FAMILY="rhel" ;;
    *)
      # 兜底：根据可用包管理器判断
      if command -v apt-get >/dev/null 2>&1; then PKG_FAMILY="debian"
      elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then PKG_FAMILY="rhel"
      else err "未识别的发行版：${OS_ID}"; exit 1; fi
      ;;
  esac
  log "检测到发行版：${PRETTY_NAME:-$OS_ID}（包管理族：${PKG_FAMILY}）"
}

# ---------------------------------------------------------------------------
# 安装 Node.js（>= NODE_MAJOR）
# ---------------------------------------------------------------------------
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge "${NODE_MAJOR}" ]
}

install_node() {
  if node_ok; then
    log "已安装满足要求的 Node.js：$(node -v)"
    return
  fi
  log "安装 Node.js ${NODE_MAJOR}.x ..."
  if [ "${PKG_FAMILY}" = "debian" ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
  else
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    if command -v dnf >/dev/null 2>&1; then dnf install -y nodejs
    else yum install -y nodejs; fi
  fi

  if ! node_ok; then
    err "Node.js 安装失败或版本低于 ${NODE_MAJOR}。当前：$(node -v 2>/dev/null || echo 无)"
    exit 1
  fi
  log "Node.js 就绪：$(node -v)"
}

verify_windows_artifact() {
  local manifest="${SOURCE_DIR}/artifacts/windows/latest.json"
  if [ ! -f "${manifest}" ]; then
    err "缺少 Windows Agent 清单：${manifest}"
    err "请先在开发机运行 server/client/deploy/publish.ps1，并将 artifacts 随服务端一起发布。"
    exit 1
  fi

  local file_name expected_hash artifact actual_hash
  file_name="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(m.fileName || "")' "${manifest}")"
  expected_hash="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write((m.sha256 || "").toLowerCase())' "${manifest}")"
  case "${file_name}" in
    ""|*/*|*\\*) err "Windows Agent 清单中的文件名无效。"; exit 1 ;;
  esac
  artifact="${SOURCE_DIR}/artifacts/windows/${file_name}"
  if [ ! -f "${artifact}" ]; then
    err "缺少 Windows Agent 制品：${artifact}"
    exit 1
  fi
  actual_hash="$(sha256sum "${artifact}" | awk '{print tolower($1)}')"
  if [ -z "${expected_hash}" ] || [ "${actual_hash}" != "${expected_hash}" ]; then
    err "Windows Agent 制品 SHA-256 校验失败。"
    exit 1
  fi
  log "Windows Agent 制品已就绪：${file_name}"
}

# ---------------------------------------------------------------------------
# 系统用户与目录
# ---------------------------------------------------------------------------
setup_user_dirs() {
  if ! id "${APP_USER}" >/dev/null 2>&1; then
    log "创建系统用户 ${APP_USER}"
    useradd --system --no-create-home --shell /usr/sbin/nologin "${APP_USER}" 2>/dev/null \
      || useradd --system --no-create-home --shell /sbin/nologin "${APP_USER}"
  fi
  mkdir -p "${INSTALL_DIR}" "${DATA_DIR}"
}

# ---------------------------------------------------------------------------
# 部署代码
# ---------------------------------------------------------------------------
deploy_code() {
  log "复制服务端代码到 ${INSTALL_DIR}"
  # 仅复制构建所需内容，排除 node_modules / data / .env / dist
  mkdir -p "${INSTALL_DIR}"
  for item in package.json package-lock.json tsconfig.json src deploy artifacts; do
    if [ -e "${SOURCE_DIR}/${item}" ]; then
      cp -r "${SOURCE_DIR}/${item}" "${INSTALL_DIR}/"
    fi
  done

  cd "${INSTALL_DIR}"

  log "安装依赖（含构建所需 devDependencies）"
  if [ -f "${INSTALL_DIR}/package-lock.json" ]; then
    npm ci
  else
    npm install
  fi

  log "编译 TypeScript -> dist/"
  npm run build

  log "裁剪为仅生产依赖"
  npm prune --omit=dev
}

# ---------------------------------------------------------------------------
# 生成 .env
# ---------------------------------------------------------------------------
write_env() {
  local env_file="${INSTALL_DIR}/.env"
  if [ -f "${env_file}" ]; then
    warn ".env 已存在，保留现有配置：${env_file}"
    return
  fi
  [ -z "${PANEL_API_KEY}" ] && PANEL_API_KEY="$(gen_key)"
  [ -z "${ENROLLMENT_KEY}" ] && ENROLLMENT_KEY="$(gen_key)"

  log "生成 ${env_file}"
  cat > "${env_file}" <<EOF
# 由 install.sh 生成 —— 请妥善保管以下密钥
PORT=${PORT}
HOST=${HOST}
PANEL_API_KEY=${PANEL_API_KEY}
ENROLLMENT_KEY=${ENROLLMENT_KEY}
OFFLINE_THRESHOLD=${OFFLINE_THRESHOLD}
DATABASE_PATH=${DATA_DIR}/control.db
ALLOW_OPEN_ENROLLMENT=${ALLOW_OPEN_ENROLLMENT}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
TRUST_PROXY=${TRUST_PROXY}
ARTIFACTS_PATH=${INSTALL_DIR}/artifacts
EOF
  chmod 600 "${env_file}"
}

# ---------------------------------------------------------------------------
# systemd 服务
# ---------------------------------------------------------------------------
install_service() {
  local node_bin
  node_bin="$(command -v node)"
  local unit="/etc/systemd/system/${APP_NAME}.service"
  log "安装 systemd 服务：${unit}"
  cat > "${unit}" <<EOF
[Unit]
Description=Control Server (面板服务端)
Documentation=https://github.com/nachomao/nacho
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${node_bin} ${INSTALL_DIR}/dist/index.js
Restart=on-failure
RestartSec=3
# 安全加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=${DATA_DIR}
ProtectHome=true
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

  chown -R "${APP_USER}:${APP_USER}" "${INSTALL_DIR}" "${DATA_DIR}"

  systemctl daemon-reload
  systemctl enable "${APP_NAME}.service"
  systemctl restart "${APP_NAME}.service"
}

# ---------------------------------------------------------------------------
# 防火墙放行（尽力而为，失败不致命）
# ---------------------------------------------------------------------------
open_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "${PORT}/tcp" || true
    log "ufw 已放行端口 ${PORT}"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="${PORT}/tcp" || true
    firewall-cmd --reload || true
    log "firewalld 已放行端口 ${PORT}"
  fi
}

summary() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo
  log "部署完成！"
  echo "  服务名称    : ${APP_NAME}.service"
  echo "  监听地址    : ${HOST}:${PORT}"
  echo "  安装目录    : ${INSTALL_DIR}"
  echo "  数据目录    : ${DATA_DIR}"
  echo "  面板 API Key: $(grep '^PANEL_API_KEY=' "${INSTALL_DIR}/.env" | cut -d= -f2-)"
  echo "  注册密钥    : $(grep '^ENROLLMENT_KEY=' "${INSTALL_DIR}/.env" | cut -d= -f2-)"
  echo
  echo "  健康检查    : curl http://${ip:-127.0.0.1}:${PORT}/health"
  echo "  Windows Agent: irm http://${ip:-127.0.0.1}:${PORT}/install.ps1 | iex"
  echo "  查看日志    : journalctl -u ${APP_NAME} -f"
  echo "  重启服务    : systemctl restart ${APP_NAME}"
  echo
  warn "请在面板「设置」中填入上面的 API Key，并在客户端安装时使用注册密钥。"
}

main() {
  require_root
  detect_os
  install_node
  verify_windows_artifact
  setup_user_dirs
  deploy_code
  write_env
  install_service
  open_firewall
  summary
}

main "$@"
