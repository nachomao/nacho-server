#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/napl-fixture.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

INSTALL_DIR="$ROOT/install"
DATA_DIR="$ROOT/data"
BACKUP_DIR="$ROOT/backups"
BIN_DIR="$ROOT/bin"
mkdir -p "$INSTALL_DIR/deploy" "$DATA_DIR" "$BACKUP_DIR" "$BIN_DIR"
cp "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/napl" "$INSTALL_DIR/deploy/napl"
chmod 755 "$INSTALL_DIR/deploy/napl"
cat >"$INSTALL_DIR/package.json" <<'JSON'
{"version":"1.0.0"}
JSON
cat >"$INSTALL_DIR/.env" <<'ENV'
HOST=127.0.0.1
PORT=18443
PANEL_API_KEY=test-panel-key
ENROLLMENT_KEY=test-enrollment-key
DATABASE_PATH=./data/control.db
ARTIFACTS_PATH=./artifacts
ENV

cat >"$BIN_DIR/node" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "-p" ]; then
  printf '1.0.0\n'
else
  exit 0
fi
SH
cat >"$BIN_DIR/systemctl" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  is-active) exit 0 ;;
  is-enabled) exit 0 ;;
  *) exit 0 ;;
esac
SH
cat >"$BIN_DIR/curl" <<'SH'
#!/usr/bin/env bash
printf '{"ok":true,"service":"nacho-server"}\n'
SH
cat >"$BIN_DIR/df" <<'SH'
#!/usr/bin/env bash
printf 'Filesystem  Size Used Avail Use%% Mounted on\n'
printf '/dev/test 10G 1G 9G 10%% /test\n'
SH
cat >"$BIN_DIR/journalctl" <<'SH'
#!/usr/bin/env bash
# 模拟实时日志：收到 Ctrl-C 后退出，供 pty 菜单测试验证父进程仍可继续。
trap 'exit 130' INT
sleep 30
SH
chmod 755 "$BIN_DIR"/*

NAPL="${INSTALL_DIR}/deploy/napl"
COMMON_ENV=(
  "PATH=${BIN_DIR}:${PATH}"
  "NAPL_INSTALL_DIR=${INSTALL_DIR}"
  "NAPL_DATA_DIR=${DATA_DIR}"
  "NAPL_BACKUP_DIR=${BACKUP_DIR}"
  "NAPL_SERVICE_NAME=control-server.service"
  "NAPL_ENTRYPOINT=${ROOT}/usr/local/bin/napl"
)

run_napl() {
  env "${COMMON_ENV[@]}" "$NAPL" "$@"
}

assert_status() {
  local expected="$1"
  shift
  set +e
  run_napl "$@" >/dev/null 2>&1
  local actual="$?"
  set -e
  [ "$actual" -eq "$expected" ] || {
    printf 'expected exit %s, got %s for napl %s\n' "$expected" "$actual" "$*" >&2
    exit 1
  }
}

assert_noninteractive_failure() {
  set +e
  run_napl "$@" >/dev/null 2>&1
  local actual="$?"
  set -e
  [ "$actual" -eq 2 ] || [ "$actual" -eq 3 ] && return 0
  printf 'unexpected exit %s for napl %s\n' "$actual" "$*" >&2
  exit 1
}

run_napl status >/dev/null
assert_status 6 update check
assert_noninteractive_failure config </dev/null
assert_noninteractive_failure unknown-command </dev/null
# 无参数进入交互菜单：无 tty 时必须拒绝（root 为 2，非 root 为 3）。
assert_noninteractive_failure </dev/null

# ---------------------------------------------------------------------------
# 交互菜单：无终端环境下验证纯渲染、键位步进与（可选）pty 冒烟测试
# ---------------------------------------------------------------------------

# source 不得执行 main；否则非 root / 无 tty 会立即退出。
env "${COMMON_ENV[@]}" bash -c 'source "$1"' _ "$NAPL"

assert_menu_index() {
  local expected="$1" current="$2" count="$3" direction="$4" actual
  actual="$(env "${COMMON_ENV[@]}" bash -c 'source "$1"; menu_step_index "$2" "$3" "$4"' \
    _ "$NAPL" "$current" "$count" "$direction")"
  [ "$actual" = "$expected" ] || {
    printf 'menu_step_index(%s,%s,%s)=%s，期望 %s\n' \
      "$current" "$count" "$direction" "$actual" "$expected" >&2
    exit 1
  }
}

assert_menu_index 8 0 9 up
assert_menu_index 0 8 9 down
assert_menu_index 1 0 9 down
assert_menu_index 7 8 9 up

plain_no_color="$(env "${COMMON_ENV[@]}" TERM=xterm-256color NO_COLOR=1 \
  bash -c 'source "$1"; style_init; menu_status_load; render_menu_frame "主菜单" 0 "${MAIN_MENU_ITEMS[@]}"' \
  _ "$NAPL")"
plain_dumb="$(env "${COMMON_ENV[@]}" TERM=dumb \
  bash -c 'source "$1"; style_init; menu_status_load; render_menu_frame "主菜单" 0 "${MAIN_MENU_ITEMS[@]}"' \
  _ "$NAPL")"

for menu_plain in "$plain_no_color" "$plain_dumb"; do
  case "$menu_plain" in
    *$'\033'*) printf '菜单在无色模式下仍输出 ANSI 转义\n' >&2; exit 1 ;;
  esac
  for needle in 'NACHO SERVER' '运行概览' '服务控制' '日志' '配置' '密钥' '备份与恢复' '升级' '卸载' '退出'; do
    printf '%s' "$menu_plain" | grep -qF "$needle" || {
      printf '菜单缺少文本：%s\n' "$needle" >&2
      exit 1
    }
  done
done

# 查看配置必须掩码三类凭据；密钥值不得出现在菜单输出中。
config_view="$(env "${COMMON_ENV[@]}" bash -c 'source "$1"; show_config' _ "$NAPL")"
printf '%s' "$config_view" | grep -qF 'PANEL_API_KEY=***隐藏***' || {
  printf '查看配置未掩码 Panel API Key\n' >&2
  exit 1
}
if printf '%s' "$config_view" | grep -qE 'test-panel-key|test-enrollment-key'; then
  printf '查看配置泄露了密钥值\n' >&2
  exit 1
fi

# pty 冒烟测试：服务控制导航，以及日志跟随 Ctrl-C 后返回菜单；缺少 python3 pty 时跳过。
if [ "$(uname -s)" = "Linux" ] && command -v python3 >/dev/null 2>&1 &&
   python3 -c 'import pty' >/dev/null 2>&1; then
  env "${COMMON_ENV[@]}" TERM=xterm-256color NO_COLOR= NAPL_TEST_NAPL="$NAPL" python3 - <<'PY'
import os, pty, select, signal, sys, time

napl = os.environ["NAPL_TEST_NAPL"]

def drain(fd, out, seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return
        if not chunk:
            return
        out.extend(chunk)

def run_session(actions, needles):
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe("bash", ["bash", "-c", 'source "$1"; menu', "_", napl], os.environ)
    out = bytearray()
    try:
        for data, wait in actions:
            drain(fd, out, wait)
            if data:
                os.write(fd, data)
        drain(fd, out, 0.5)
        status = None
        deadline = time.time() + 6
        while time.time() < deadline:
            drain(fd, out, 0.1)
            try:
                waited, state = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                status = 0
                break
            if waited == pid:
                status = state
                break
        if status is None:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            return "交互菜单 pty 测试超时"
        text = out.decode("utf-8", "replace")
        missing = [name for name in needles if name not in text]
        if missing:
            return "交互菜单 pty 输出缺少：%s" % ", ".join(repr(x) for x in missing)
        if not (os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0):
            return "交互菜单 pty 子进程状态异常：%s" % status
        return ""
    finally:
        try:
            os.close(fd)
        except OSError:
            pass

cases = [
    (
        [(None, 1.0), (b"\x1b[B\n", 1.0), (b"q", 0.5), (b"q", 0.5)],
        ["NACHO SERVER", "运行概览", "服务控制", "启动服务", "密钥", "\x1b["],
        "服务控制导航",
    ),
    (
        [(None, 1.0), (b"3", 0.8), (b"2", 0.8), (b"\x03", 0.8), (b"\n", 0.5), (b"q", 0.3), (b"q", 0.5)],
        ["NACHO SERVER", "实时跟随", "journalctl"],
        "日志跟随 Ctrl-C 后返回菜单",
    ),
    (
        [(None, 1.0), (b"5", 0.6), (b"q", 0.4), (b"4", 0.6), (b"q", 0.4),
         (b"6", 0.6), (b"q", 0.4), (b"q", 0.4)],
        ["轮换 Panel API Key", "轮换 Enrollment Key", "查看当前配置", "立即创建备份", "恢复备份"],
        "密钥/配置/备份子菜单",
    ),
    (
        [(None, 1.0), (b"4", 0.6), (b"2", 0.6), (b"\n" * 9, 1.0), (b"q", 0.4), (b"q", 0.4)],
        ["监听地址 HOST", "配置未变更"],
        "配置逐项回车保持原值",
    ),
    (
        [(None, 1.0), (b"2", 0.6), (b"1", 0.8), (b"\n", 0.5), (b"q", 0.4), (b"q", 0.4)],
        ["服务操作完成：start"],
        "服务控制执行动作并暂停",
    ),
]

failed = False
for actions, needles, label in cases:
    error = run_session(actions, needles)
    if error:
        print("%s：%s" % (label, error), file=sys.stderr)
        failed = True
if failed:
    sys.exit(1)
print("menu pty test passed")
PY
else
  printf 'napl 交互菜单 pty 测试已跳过（需要 Linux + python3 pty）\n' >&2
fi

printf 'napl fixture passed\n'
