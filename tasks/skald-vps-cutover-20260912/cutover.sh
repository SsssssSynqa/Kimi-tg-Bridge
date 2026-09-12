#!/bin/bash
# 鸦鸦生产切换 Mac → LA。只在 Synqa 明确批准后由 Sylux 手动执行。
# 顺序合同：停 Mac 桥（launchd disable→bootout）→ 停 Mac TUI（tmux kill-session skald-tg，等它退出）
#          → 拷最新 Kimi OAuth（轮换制，只能一台机器活着）→ 最终增量同步 .state/sessions → LA 起桥（桥自己拉 TUI）→ 验证同一 session、唯一 poller。
set -euo pipefail
B=/Users/arthas/Desktop/Synergia/Kimi/skald-tg-bridge
EV=$B/tasks/skald-vps-cutover-20260912/evidence; mkdir -p "$EV"; TS=$(date -u +%Y%m%dT%H%M%SZ)
U=gui/$(id -u); TMUX=/usr/local/bin/tmux
R="rsync -az --partial --stats --delete"
echo "== [0] 预检：LA unit inactive、token 在位、Mac 桥在跑"
ssh syner-vps 'bash -se' <<'REMOTE_PREFLIGHT'
set -euo pipefail
test "$(systemctl show skald-bridge -p ActiveState --value)" = inactive
test "$(systemctl show skald-bridge -p MainPID --value)" = 0
test -s /etc/skald/telegram.token
if pgrep -u skald -f 'skald-tg-bridge/src/bridge[.]mjs|(^|/)(kimi|kimi-cli)( |$)' >/dev/null; then
  echo 'LA bridge/Kimi process already running' >&2; exit 1
else
  status=$?; test "$status" = 1
fi
REMOTE_PREFLIGHT
echo "== [1] 停 Mac 桥"
launchctl disable "$U/com.synergia.skald-bridge"; launchctl bootout "$U/com.synergia.skald-bridge" || true
sleep 3
if pgrep -fl 'skald-tg-bridge/src/bridge[.]mjs'; then
  echo "桥仍在跑，停止"; exit 1
else
  status=$?; test "$status" = 1
fi
echo "== [2] 停 Mac TUI（只杀 skald-tg 这个 session，绝不 kill tmux server）"
$TMUX kill-session -t skald-tg || true; sleep 5
if $TMUX has-session -t skald-tg 2>/dev/null; then
  echo "TUI 还在，停止"; exit 1
else
  status=$?; test "$status" = 1
fi
if pgrep -u "$(id -u)" -f '(^|/)(kimi|kimi-cli)( |$)' >/dev/null; then
  echo "Mac Kimi 仍在运行，暂不迁移 OAuth"; exit 1
else
  status=$?; test "$status" = 1
fi
echo "== [3] 冻结 manifest"
manifest_file() {
  local label=$1 file=$2 bytes hash
  bytes=$(wc -c <"$file" | tr -d '[:space:]')
  hash=$(shasum -a 256 "$file" | cut -c1-16)
  printf '%s %s %s\n' "$label" "$bytes" "$hash"
}
{
  SESSION=$(cat "$B/.state/session.txt"); OFFSET=$(cat "$B/.state/offset.txt")
  printf 'session %s\noffset %s\n' "$SESSION" "$OFFSET"
  for f in .state/telegram-updates.raw.jsonl .state/telegram-updates.journal.jsonl .state/telegram-live.jsonl .state/dynamic-groups.json .state/group-context-cursors.json; do
    manifest_file "$f" "$B/$f"
  done
  W=~/.kimi-code/sessions/wd_kimi_56ec3c829562/$SESSION/agents/main/wire.jsonl
  manifest_file wire "$W"
} | tee "$EV/$TS-mac-frozen.txt"
echo "== [4] 拷最新 OAuth（Mac 侧 TUI 已停，这一对从此只在 LA 活着）"
ssh syner-vps 'set -eu; install -d -m 700 -o skald -g skald /srv/skald/.kimi-code/credentials; install -m 600 -o skald -g skald /dev/stdin /srv/skald/.kimi-code/credentials/kimi-code.json' < ~/.kimi-code/credentials/kimi-code.json
echo "== [5] 最终增量同步"
$R --exclude='*.log' --exclude='.state/*.lock' --exclude='.local-backups' --exclude='config.json' --exclude='tasks/skald-vps-cutover-20260912/evidence' "$B/" syner-vps:/srv/synergia/Kimi/skald-tg-bridge/
$R "$B/../attachments/" syner-vps:/srv/synergia/Kimi/attachments/
$R ~/.kimi-code/sessions/wd_kimi_56ec3c829562/ syner-vps:/srv/skald/.kimi-code/sessions/wd_kimi_56ec3c829562/
rsync -az ~/.kimi-code/session_index.jsonl syner-vps:/srv/skald/.kimi-code/session_index.jsonl
ssh syner-vps 'set -eu; chown -R skald:synergia /srv/synergia/Kimi/skald-tg-bridge /srv/synergia/Kimi/attachments; chown -R skald:skald /srv/skald/.kimi-code; chmod 700 /srv/synergia/Kimi/skald-tg-bridge/.state; rm -f /srv/synergia/Kimi/skald-tg-bridge/.state/*.lock'
echo "== [6] LA 对账"
ssh syner-vps 'bash -se' <<'REMOTE_MANIFEST' | tee "$EV/$TS-la.txt"
set -euo pipefail
B=/srv/synergia/Kimi/skald-tg-bridge
manifest_file() {
  local label=$1 file=$2 bytes hash
  bytes=$(wc -c <"$file" | tr -d '[:space:]')
  hash=$(sha256sum "$file" | cut -c1-16)
  printf '%s %s %s\n' "$label" "$bytes" "$hash"
}
SESSION=$(cat "$B/.state/session.txt"); OFFSET=$(cat "$B/.state/offset.txt")
printf 'session %s\noffset %s\n' "$SESSION" "$OFFSET"
for f in .state/telegram-updates.raw.jsonl .state/telegram-updates.journal.jsonl .state/telegram-live.jsonl .state/dynamic-groups.json .state/group-context-cursors.json; do
  manifest_file "$f" "$B/$f"
done
W=/srv/skald/.kimi-code/sessions/wd_kimi_56ec3c829562/$SESSION/agents/main/wire.jsonl
manifest_file wire "$W"
REMOTE_MANIFEST
diff "$EV/$TS-mac-frozen.txt" "$EV/$TS-la.txt" && echo "MANIFEST MATCH" || { echo "manifest 不一致，停止（Mac 保持停机，先回滚 A）"; exit 1; }
echo "== [7] 起 LA 桥（它会在 tmux skald-tg 里拉起 TUI --session 同一个 id）"
ssh syner-vps 'bash -se' <<'REMOTE_START'
set -euo pipefail
systemctl enable --now skald-bridge
sleep 25
systemctl is-active --quiet skald-bridge
journalctl -u skald-bridge -n 25 --no-pager
sudo -u skald /usr/bin/tmux capture-pane -p -t skald-tg | sed '/^[[:space:]]*$/d' | tail -15
REMOTE_START
echo "== 完成。Mac launchd 保持 disabled；Mac 原目录一字不删。"
