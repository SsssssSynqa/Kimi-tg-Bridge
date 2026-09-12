#!/bin/bash
# Rollback A：LA 桥还没收到新 update。停 LA → 把 LA 的（可能已轮换的）OAuth 拷回 Mac → 起 Mac。
set -euo pipefail
U=gui/$(id -u)
ssh syner-vps 'bash -se' <<'REMOTE_STOP'
set -euo pipefail
systemctl disable --now skald-bridge
sleep 2
test "$(systemctl show skald-bridge -p ActiveState --value)" = inactive
test "$(systemctl show skald-bridge -p MainPID --value)" = 0
if sudo -u skald /usr/bin/tmux has-session -t skald-tg 2>/dev/null; then
  sudo -u skald /usr/bin/tmux kill-session -t skald-tg
else
  status=$?; test "$status" = 1
fi
sleep 2
if sudo -u skald /usr/bin/tmux has-session -t skald-tg 2>/dev/null; then
  echo 'LA TUI still running; Mac remains stopped' >&2; exit 1
else
  status=$?; test "$status" = 1
fi
# The inactive unit alone does not prove that an orphan OAuth writer/poller is gone.
if pgrep -u skald -f 'skald-tg-bridge/src/bridge[.]mjs|(^|/)(kimi|kimi-cli)( |$)' >/dev/null; then
  echo 'LA bridge/Kimi process still running; Mac remains stopped' >&2; exit 1
else
  status=$?; test "$status" = 1
fi
REMOTE_STOP
CRED="$HOME/.kimi-code/credentials/kimi-code.json"
umask 077
TMP_CRED=$(mktemp "${CRED}.rollback.XXXXXX")
trap 'rm -f "$TMP_CRED"' EXIT
ssh syner-vps 'cat /srv/skald/.kimi-code/credentials/kimi-code.json' > "$TMP_CRED"
# Validate the actual Kimi OAuth shape, not its freshness: an expired access token
# with a valid rotating refresh token may still be the only recoverable credential.
python3 - "$TMP_CRED" <<'PY_CREDENTIAL'
import json, math, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
if not isinstance(value, dict):
    raise SystemExit("Invalid OAuth credential object; Mac remains stopped")
if any(not isinstance(value.get(k), str) or not value[k].strip()
       for k in ("access_token", "refresh_token")):
    raise SystemExit("Missing OAuth token fields; Mac remains stopped")
expiry = value.get("expires_at")
if isinstance(expiry, bool) or not isinstance(expiry, (int, float)) or not math.isfinite(expiry) or expiry <= 0:
    raise SystemExit("Invalid OAuth expiry; Mac remains stopped")
PY_CREDENTIAL
cp -p "$CRED" "${CRED}.bak-rollback-$(date +%Y%m%d%H%M%S)"
chmod 600 "$TMP_CRED"
mv -f "$TMP_CRED" "$CRED"
launchctl enable "$U/com.synergia.skald-bridge"
launchctl bootstrap "$U" ~/Library/LaunchAgents/com.synergia.skald-bridge.plist
sleep 15
PRINT=$(launchctl print "$U/com.synergia.skald-bridge")
printf '%s\n' "$PRINT"
printf '%s\n' "$PRINT" | grep -q 'state = running'
PID=$(printf '%s\n' "$PRINT" | awk '$1 == "pid" && $2 == "=" { print $3; exit }')
case "$PID" in ''|*[!0-9]*|0) echo 'Mac bridge 没有有效 PID' >&2; exit 1;; esac
kill -0 "$PID"
tail -5 /Users/arthas/Desktop/Synergia/Kimi/skald-tg-bridge/bridge.log
