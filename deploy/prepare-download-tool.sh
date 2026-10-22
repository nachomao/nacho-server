#!/usr/bin/env bash
# 只安装固定的 aria2 软件包，不接受包名、URL 或任意命令。
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--install-only" ]; }; then
  echo "[Nacho] 下载工具准备参数无效" >&2
  exit 2
fi
if command -v aria2c >/dev/null 2>&1; then
  echo "[Nacho] aria2 已安装"
  exit 0
fi
if [ "$(id -u)" != 0 ]; then
  echo "[Nacho] 安装 aria2 需要固定 root 执行入口" >&2
  exit 3
fi
if command -v flock >/dev/null 2>&1; then
  exec 9>/run/lock/nacho-aria2.lock
  flock -n 9 || { echo "[Nacho] aria2 安装已在进行" >&2; exit 75; }
fi
echo "[Nacho] 正在安装 aria2（最多三分钟）"
timeout --signal=TERM --kill-after=5s 175s /bin/bash -c '
  set -eu
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get -o DPkg::Lock::Timeout=20 install -y aria2
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y aria2
  elif command -v yum >/dev/null 2>&1; then
    yum install -y aria2
  else
    echo "[Nacho] 没有支持的系统包管理器" >&2
    exit 1
  fi
'
command -v aria2c >/dev/null 2>&1
echo "[Nacho] aria2 已就绪"
