#!/bin/bash
# 鸦鸦生产切换 Mac → LA。只在 Synqa 明确批准后由 Sylux 手动执行。
# 顺序合同：停 Mac 桥（launchd disable→bootout）→ 停 Mac TUI（tmux kill-session skald-tg，等它退出）
#          → 拷最新 Kimi OAuth（轮换制，只能一台机器活着）→ 最终增量同步 .state/sessions → LA 起桥（桥自己拉 TUI）→ 验证同一 session、唯一 poller。
set -eu
B=/Users/arthas/Desktop/Synergia/Kimi/skald-tg-bridge
EV=$B/tasks/skald-vps-cutover-20260912/evidence; mkdir -p "$EV"; TS=$(date -u +%Y%m%dT%H%M%SZ)
U=gui/$(id -u); TMUX=/usr/local/bin/tmux
R="rsync -az --partial --stats --delete"
echo "== [0] 预检：LA unit inactive、token 在位、Mac 桥在跑"
ssh syner-vps 'systemctl is-active skald-bridge || true; test -s /etc/skald/telegram.token && echo token-ok'
ssh syner-vps 'systemctl is-active skald-bridge' | grep -q '^inactive' || { echo "LA skald-bridge 不是 inactive，停止"; exit 1; }
echo "== [1] 停 Mac 桥"
launchctl disable "$U/com.synergia.skald-bridge"; launchctl bootout "$U/com.synergia.skald-bridge" || true
sleep 3; pgrep -fl 'skald-tg-bridge/src/bridge.mjs' && { echo "桥仍在跑，停止"; exit 1; } || echo "桥已停"
echo "== [2] 停 Mac TUI（只杀 skald-tg 这个 session，绝不 kill tmux server）"
$TMUX kill-session -t skald-tg || true; sleep 5
$TMUX has-session -t skald-tg 2>/dev/null && { echo "TUI 还在，停止"; exit 1; } || echo "TUI 已退出"
echo "== [3] 冻结 manifest"
{ echo "session $(cat "$B/.state/session.txt")"; echo "offset $(cat "$B/.state/offset.txt")";
  for f in .state/telegram-updates.raw.jsonl .state/telegram-updates.journal.jsonl .state/telegram-live.jsonl .state/dynamic-groups.json .state/group-context-cursors.json; do
    echo "$f $(wc -c <"$B/$f") $(shasum -a 256 "$B/$f" | cut -c1-16)"; done;
  W=~/.kimi-code/sessions/wd_kimi_56ec3c829562/$(cat "$B/.state/session.txt")/agents/main/wire.jsonl; echo "wire $(wc -c <"$W") $(shasum -a 256 "$W" | cut -c1-16)"; } | tee "$EV/$TS-mac-frozen.txt"
echo "== [4] 拷最新 OAuth（Mac 侧 TUI 已停，这一对从此只在 LA 活着）"
ssh syner-vps 'install -d -m 700 -o skald -g skald /srv/skald/.kimi-code/credentials; install -m 600 -o skald -g skald /dev/stdin /srv/skald/.kimi-code/credentials/kimi-code.json' < ~/.kimi-code/credentials/kimi-code.json
echo "== [5] 最终增量同步"
$R --exclude='*.log' --exclude='.state/*.lock' --exclude='.local-backups' --exclude='config.json' --exclude='tasks/skald-vps-cutover-20260912/evidence' "$B/" syner-vps:/srv/synergia/Kimi/skald-tg-bridge/
$R "$B/../attachments/" syner-vps:/srv/synergia/Kimi/attachments/
$R ~/.kimi-code/sessions/wd_kimi_56ec3c829562/ syner-vps:/srv/skald/.kimi-code/sessions/wd_kimi_56ec3c829562/
rsync -az ~/.kimi-code/session_index.jsonl syner-vps:/srv/skald/.kimi-code/session_index.jsonl
ssh syner-vps 'chown -R skald:synergia /srv/synergia/Kimi/skald-tg-bridge /srv/synergia/Kimi/attachments; chown -R skald:skald /srv/skald/.kimi-code; chmod 700 /srv/synergia/Kimi/skald-tg-bridge/.state; rm -f /srv/synergia/Kimi/skald-tg-bridge/.state/*.lock'
echo "== [6] LA 对账"
ssh syner-vps 'B=/srv/synergia/Kimi/skald-tg-bridge; echo "session $(cat $B/.state/session.txt)"; echo "offset $(cat $B/.state/offset.txt)"; for f in .state/telegram-updates.raw.jsonl .state/telegram-updates.journal.jsonl .state/telegram-live.jsonl .state/dynamic-groups.json .state/group-context-cursors.json; do echo "$f $(wc -c <$B/$f) $(sha256sum $B/$f | cut -c1-16)"; done; W=/srv/skald/.kimi-code/sessions/wd_kimi_56ec3c829562/$(cat $B/.state/session.txt)/agents/main/wire.jsonl; echo "wire $(wc -c <$W) $(sha256sum $W | cut -c1-16)"' | tee "$EV/$TS-la.txt"
diff <(tr -s " " < "$EV/$TS-mac-frozen.txt") <(tr -s " " < "$EV/$TS-la.txt") && echo "MANIFEST MATCH" || { echo "manifest 不一致，停止（Mac 保持停机，先回滚 A）"; exit 1; }
echo "== [7] 起 LA 桥（它会在 tmux skald-tg 里拉起 TUI --session 同一个 id）"
ssh syner-vps 'systemctl enable --now skald-bridge; sleep 25; systemctl is-active skald-bridge; journalctl -u skald-bridge -n 25 --no-pager; sudo -u skald tmux capture-pane -p -t skald-tg | grep -v "^\s*$" | tail -15'
echo "== 完成。Mac launchd 保持 disabled；Mac 原目录一字不删。"
