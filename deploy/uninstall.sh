#!/usr/bin/env bash
#
# 卸载脚本 —— 面板服务端
# 用法：sudo ./uninstall.sh            # 保留数据目录
#       sudo PURGE=1 ./uninstall.sh    # 同时删除数据与用户
#
set -euo pipefail

APP_NAME="${APP_NAME:-control-server}"
APP_USER="${APP_USER:-control}"
INSTALL_DIR="${INSTALL_DIR:-/opt/${APP_NAME}}"
DATA_DIR="${DATA_DIR:-/var/lib/${APP_NAME}}"
PURGE="${PURGE:-0}"

log()  { printf '\033[1;32m[uninstall]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "请以 root 运行（或使用 sudo）。" >&2
  exit 1
fi

if systemctl list-unit-files 2>/dev/null | grep -q "^${APP_NAME}.service"; then
  log "停止并禁用服务 ${APP_NAME}"
  systemctl stop "${APP_NAME}.service" || true
  systemctl disable "${APP_NAME}.service" || true
  rm -f "/etc/systemd/system/${APP_NAME}.service"
  systemctl daemon-reload
fi

log "删除安装目录 ${INSTALL_DIR}"
rm -rf "${INSTALL_DIR}"

if [ "${PURGE}" = "1" ]; then
  warn "PURGE=1：删除数据目录 ${DATA_DIR} 与系统用户 ${APP_USER}"
  rm -rf "${DATA_DIR}"
  if id "${APP_USER}" >/dev/null 2>&1; then
    userdel "${APP_USER}" || true
  fi
else
  warn "已保留数据目录：${DATA_DIR}（如需彻底删除，请使用 PURGE=1 重新执行）"
fi

log "卸载完成。"
