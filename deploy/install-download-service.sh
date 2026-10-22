#!/usr/bin/env bash
# 安装 root 拥有的 aria2 准备入口；安装和已验证的升级共用此脚本。
set -euo pipefail
if [ "$(id -u)" != 0 ]; then exit 3; fi
APP_USER="${APP_USER:-control}"
DATA_DIR="${DATA_DIR:-/var/lib/control-server}"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$DATA_DIR" != /var/lib/control-server ]; then exit 0; fi
ROOT=/usr/local/lib/nacho-downloader
for directory in "$ROOT" "$DATA_DIR/download-tool-status" "$DATA_DIR/download-tool-requests"; do
  [ ! -L "$directory" ] || { echo "[Nacho] 下载工具目录不能是符号链接" >&2; exit 1; }
done
install -d -m 755 -o root -g root "$ROOT" "$DATA_DIR/download-tool-status"
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR/download-tool-requests"
install -m 755 -o root -g root "$SOURCE/prepare-download-tool.sh" "$ROOT/prepare-download-tool.sh"
install -m 644 -o root -g root "$SOURCE/prepare-download-tool.mjs" "$ROOT/prepare-download-tool.mjs"
if [ -f "$DATA_DIR/download-tool-status/aria2.json" ] && [ ! -L "$DATA_DIR/download-tool-status/aria2.json" ]; then
  chown root:root "$DATA_DIR/download-tool-status/aria2.json"
  chmod 644 "$DATA_DIR/download-tool-status/aria2.json"
fi
node_bin="$(command -v node)"
cat > /etc/systemd/system/control-server-downloader.service <<EOF
[Unit]
Description=Nacho fixed aria2 preparation
After=network-online.target

[Service]
Type=oneshot
User=root
ExecStart=${node_bin} ${ROOT}/prepare-download-tool.mjs
TimeoutStartSec=3min
KillMode=control-group
EOF
cat > /etc/systemd/system/control-server-downloader.path <<EOF
[Unit]
Description=Nacho fixed download-tool request

[Path]
PathExists=${DATA_DIR}/download-tool-requests/aria2.json
Unit=control-server-downloader.service

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now control-server-downloader.path
