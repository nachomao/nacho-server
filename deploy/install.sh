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
ALLOW_OPEN_ENROLLMENT="${ALLOW_OPEN_ENROLLMENT:-true}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
TRUST_PROXY="${TRUST_PROXY:-false}"

# 密钥：未提供则生成随机值
PANEL_API_KEY="${PANEL_API_KEY:-}"
ENROLLMENT_KEY="${ENROLLMENT_KEY:-}"

# 脚本所在目录（deploy），其上级即源码根目录
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
  for item in package.json package-lock.json tsconfig.json src deploy; do
    if [ -e "${SOURCE_DIR}/${item}" ]; then
      cp -r "${SOURCE_DIR}/${item}" "${INSTALL_DIR}/"
    fi
  done
  # Agent 制品独立发布；已有持久化制品保留，首次安装由服务端按签名索引拉取。
  mkdir -p "${INSTALL_DIR}/artifacts/windows"

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
  chmod 755 "${INSTALL_DIR}/deploy/napl"
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
  chmod 640 "${env_file}"
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
Documentation=https://github.com/nachomao/nacho-server
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
  chown "root:${APP_USER}" "${INSTALL_DIR}/.env"
  chmod 640 "${INSTALL_DIR}/.env"

  local entry="/usr/local/bin/napl"
  if [ -e "${entry}" ] || [ -L "${entry}" ]; then
    if [ "$(readlink -f "${entry}" 2>/dev/null || true)" != "${INSTALL_DIR}/deploy/napl" ]; then
      err "${entry} 已由其他安装占用，停止以避免覆盖。"
      exit 1
    fi
  fi
  ln -sfn "${INSTALL_DIR}/deploy/napl" "${entry}"

  # 升级代理始终从 root 拥有的副本运行；Node 服务仅能写入固定请求文件。
  if [ "${APP_NAME}" = "control-server" ] && [ "${DATA_DIR}" = "/var/lib/control-server" ]; then
    local broker="/usr/local/lib/nacho-updater"
    install -d -m 755 -o root -g root "${broker}"
    install -m 755 -o root -g root "${INSTALL_DIR}/deploy/execute-update.mjs" "${broker}/execute-update.mjs"
    install -m 755 -o root -g root "${INSTALL_DIR}/deploy/napl" "${broker}/napl"
    install -m 644 -o root -g root "${INSTALL_DIR}/deploy/napl-release-public.pem" "${broker}/release-public.pem"
    install -d -m 700 -o "${APP_USER}" -g "${APP_USER}" "${DATA_DIR}/update-requests"
    install -d -m 755 -o root -g root "${DATA_DIR}/update-status"
    if [ -f "${DATA_DIR}/update-status/status.json" ]; then
      chown root:root "${DATA_DIR}/update-status/status.json"
      chmod 644 "${DATA_DIR}/update-status/status.json"
    fi
    cat > /etc/systemd/system/control-server-updater.service <<EOF
[Unit]
Description=Nacho signed control-server update executor
After=network-online.target

[Service]
Type=oneshot
User=root
EnvironmentFile=-${INSTALL_DIR}/.env
ExecStart=${node_bin} ${broker}/execute-update.mjs
TimeoutStartSec=20min
EOF
    cat > /etc/systemd/system/control-server-updater.path <<EOF
[Unit]
Description=Nacho control-server update request

[Path]
PathExists=${DATA_DIR}/update-requests/request.json
Unit=control-server-updater.service

[Install]
WantedBy=multi-user.target
EOF
  fi

  systemctl daemon-reload
  systemctl enable "${APP_NAME}.service"
  if [ -f /etc/systemd/system/control-server-updater.path ]; then
    systemctl enable --now control-server-updater.path
  fi
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

env_file_get() {
  local key="$1" file="${INSTALL_DIR}/.env"
  [ -f "$file" ] || return 0
  awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      sub("^[[:space:]]*" key "[[:space:]]*=[[:space:]]*", "", $0)
      sub("[[:space:]]+$", "", $0)
      print $0
      exit
    }
  ' "$file"
}

env_file_set() {
  local key="$1" value="$2" file="${INSTALL_DIR}/.env" temp
  [ -f "$file" ] || return 1
  temp="$(mktemp "${file}.tmp.XXXXXX")" || return 1
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      print key "=" value
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$file" >"$temp" || { rm -f "$temp"; return 1; }
  chmod 640 "$temp"
  chown --reference="$file" "$temp" 2>/dev/null || { rm -f "$temp"; return 1; }
  mv -f "$temp" "$file"
}

summary() {
  local ip listen_host host port base url once shown hide_keys=0 hide_url=0 one_time=0
  local panel_key enrollment_key
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  listen_host="$(env_file_get HOST)"; listen_host="${listen_host:-$HOST}"
  port="$(env_file_get PORT)"; port="${port:-$PORT}"
  base="$(env_file_get PUBLIC_BASE_URL)"
  host="$listen_host"
  case "$host" in
    ""|0.0.0.0|::|"[::]") host="${ip:-127.0.0.1}" ;;
  esac
  case "$host" in
    *:*) host="[$host]" ;;
  esac
  url="${base%/}"
  if [ -z "$url" ]; then
    url="http://${host}:${port}"
  fi

  once="$(env_file_get NACHO_ACCESS_INFO_ONCE)"
  shown="$(env_file_get NACHO_ACCESS_INFO_SHOWN)"
  if [ "${NACHO_HIDE_INSTALL_SECRETS:-0}" = "1" ]; then
    hide_keys=1
  fi
  if [ "$once" = "1" ] && [ "$shown" = "1" ]; then
    hide_keys=1
    hide_url=1
  elif [ "$hide_keys" != 1 ] && [ "$once" = "1" ]; then
    if env_file_set NACHO_ACCESS_INFO_SHOWN 1; then
      one_time=1
    else
      hide_keys=1
      hide_url=1
      warn "无法记录一次性展示状态，已隐藏访问信息。"
    fi
  fi

  echo
  log "部署完成！"
  echo "  服务名称    : ${APP_NAME}.service"
  echo "  监听地址    : ${listen_host}:${port}"
  echo "  安装目录    : ${INSTALL_DIR}"
  echo "  数据目录    : ${DATA_DIR}"
  if [ "$hide_url" = 1 ]; then
    echo "  面板/API 地址: 已隐藏（一次性展示）"
  else
    echo "  面板/API 地址: ${url}"
  fi
  if [ "$hide_keys" = 1 ]; then
    echo "  Panel API Key: 已隐藏"
    echo "  注册密钥    : 已隐藏"
  else
    panel_key="$(env_file_get PANEL_API_KEY)"
    enrollment_key="$(env_file_get ENROLLMENT_KEY)"
    echo "  Panel API Key: ${panel_key:-未配置}"
    echo "  注册密钥    : ${enrollment_key:-未配置}"
  fi
  echo
  if [ "$hide_url" = 1 ]; then
    echo "  健康检查    : curl http://<服务器地址>:${port}/health"
    echo "  Windows Agent: irm http://<服务器地址>:${port}/nacho.ps1 | iex"
  else
    echo "  健康检查    : curl ${url}/health"
    echo "  Windows Agent: irm ${url}/nacho.ps1 | iex"
  fi
  echo "  查看日志    : journalctl -u ${APP_NAME} -f"
  echo "  重启服务    : systemctl restart ${APP_NAME}"
  echo
  if [ "$one_time" = 1 ]; then
    warn "访问信息已按一次性展示设置显示；菜单与后续重装摘要将不再显示。"
  fi
  if [ "$hide_keys" != 1 ]; then
    warn "请在面板「设置」中填入上面的 API Key，并在客户端安装时使用注册密钥。"
  fi
}

main() {
  require_root
  detect_os
  install_node
  if ! bash "${SCRIPT_DIR}/prepare-download-tool.sh" --install-only; then
    warn "aria2 自动准备失败，GitHub 文件下载将使用单连接。"
  fi
  setup_user_dirs
  deploy_code
  write_env
  install_service
  APP_USER="${APP_USER}" DATA_DIR="${DATA_DIR}" bash "${SCRIPT_DIR}/install-download-service.sh" ||
    warn "固定下载工具准备入口安装失败，缺少工具时将使用单连接。"
  open_firewall
  summary
}

# 仅在直接执行时进入主流程；夹具可 source 本文件以验证安装摘要策略。
if [ "${BASH_SOURCE[0]:-}" = "$0" ] || [ -z "${BASH_SOURCE[0]:-}" ]; then
  main "$@"
fi
