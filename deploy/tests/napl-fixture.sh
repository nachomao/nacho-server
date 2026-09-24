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
assert_noninteractive_failure config </dev/null
assert_noninteractive_failure unknown-command </dev/null

printf 'napl fixture passed\n'
