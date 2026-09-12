#!/bin/bash
# Rollback A：LA 桥还没收到新 update。停 LA → 把 LA 的（可能已轮换的）OAuth 拷回 Mac → 起 Mac。
set -eu; U=gui/$(id -u)
ssh syner-vps 'systemctl disable --now skald-bridge; sleep 2; sudo -u skald tmux kill-session -t skald-tg 2>/dev/null || true; systemctl is-active skald-bridge || true'
cp -p ~/.kimi-code/credentials/kimi-code.json ~/.kimi-code/credentials/kimi-code.json.bak-rollback-$(date +%Y%m%d%H%M)
ssh syner-vps 'cat /srv/skald/.kimi-code/credentials/kimi-code.json' > ~/.kimi-code/credentials/kimi-code.json; chmod 600 ~/.kimi-code/credentials/kimi-code.json
launchctl enable "$U/com.synergia.skald-bridge"; launchctl bootstrap "$U" ~/Library/LaunchAgents/com.synergia.skald-bridge.plist; sleep 15
launchctl list | grep skald; tail -5 /Users/arthas/Desktop/Synergia/Kimi/skald-tg-bridge/bridge.log
