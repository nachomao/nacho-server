#!/usr/bin/env bash
set -euo pipefail
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/nacho-tools-fixture.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/prepare-download-tool.sh"
export TEST_ARIA2_MARKER="$ROOT/installed" TEST_ARIA2_LOG="$ROOT/calls"

# 仅在子 shell 中替代系统命令；夹具不执行真实包管理器或安装系统软件。
id() { if [ "${1:-}" = -u ]; then printf '%s\n' "${TEST_ARIA2_UID:-0}"; else /usr/bin/id "$@"; fi; }
command() {
  if [ "${1:-}" = -v ]; then
    case "${2:-}" in
      aria2c) [ -f "$TEST_ARIA2_MARKER" ]; return ;;
      flock) return 1 ;;
      apt-get|dnf|yum) [ "${2:-}" = "${TEST_ARIA2_MANAGER:-apt-get}" ]; return ;;
    esac
  fi
  builtin command "$@"
}
apt-get() {
  printf 'apt-get %s\n' "$*" >>"$TEST_ARIA2_LOG"
  [ "${TEST_ARIA2_FAIL:-0}" = 0 ] || return 1
  if [[ " $* " = *" install "* ]]; then touch "$TEST_ARIA2_MARKER"; fi
}
dnf() { printf 'dnf %s\n' "$*" >>"$TEST_ARIA2_LOG"; touch "$TEST_ARIA2_MARKER"; }
yum() { printf 'yum %s\n' "$*" >>"$TEST_ARIA2_LOG"; touch "$TEST_ARIA2_MARKER"; }
timeout() { printf 'timeout %s\n' "$1 $2 $3" >>"$TEST_ARIA2_LOG"; shift 3; "$@"; }
export -f id command apt-get dnf yum timeout

for manager in apt-get dnf yum; do
  rm -f "$TEST_ARIA2_MARKER" "$TEST_ARIA2_LOG"
  TEST_ARIA2_MANAGER="$manager" bash "$SCRIPT" --install-only >/dev/null
  [ -f "$TEST_ARIA2_MARKER" ]
  grep -q "$manager .*install -y aria2" "$TEST_ARIA2_LOG"
  grep -q '175s' "$TEST_ARIA2_LOG"
done
rm -f "$TEST_ARIA2_LOG"
bash "$SCRIPT" --install-only >/dev/null
[ ! -f "$TEST_ARIA2_LOG" ]

rm -f "$TEST_ARIA2_MARKER"
if TEST_ARIA2_UID=1000 bash "$SCRIPT" --install-only >/dev/null 2>&1; then exit 1; fi
if TEST_ARIA2_FAIL=1 bash "$SCRIPT" --install-only >/dev/null 2>&1; then exit 1; fi
if bash "$SCRIPT" '--install=arbitrary' >/dev/null 2>&1; then exit 1; fi
printf 'download tool fixture passed\n'
