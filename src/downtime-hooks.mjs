// 鸦鸦（Skald）桥的停机协议接线 —— 停机协议 Plan v3.2 步骤 2/5/6（2026-09-06）。
//
// 通用逻辑住在 shared/downtime-bridge-hooks.mjs（三座订阅制桥行为必须一致，只写一份）；
// 这里只提供 Skald 的差异：桥名、控制目录（.state/control）、offset 文件、
// 以及「百分比水位 → 剩余 token」的换算（他的 TUI 只给百分比，没有绝对数）。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridgeDowntimeHooks, runCatchupCommand, remainingFromPercent } from '../../../shared/downtime-bridge-hooks.mjs';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BRIDGE_ROOT = path.resolve(SRC_DIR, '..');
export const SYNERGIA_ROOT = path.resolve(BRIDGE_ROOT, '..', '..');
export const BRIDGE_ID = 'skald';

export function createDowntimeHooks({ durableInbox, log, stateDir = path.join(BRIDGE_ROOT, '.state'), root = SYNERGIA_ROOT } = {}) {
  return createBridgeDowntimeHooks({
    bridge: BRIDGE_ID, durableInbox, root, log,
    controlDir: path.join(stateDir, 'control'),
    offsetPath: path.join(stateDir, 'offset.txt'),
  });
}

export function handleCatchupCommand({ root = SYNERGIA_ROOT, bridge = BRIDGE_ID, contextPercent = null, contextCapacityTokens = null, ...rest }) {
  const remainingTokens = remainingFromPercent(contextPercent, contextCapacityTokens);
  return runCatchupCommand({ root, bridge, usage: remainingTokens === null ? null : { remainingTokens }, ...rest });
}
