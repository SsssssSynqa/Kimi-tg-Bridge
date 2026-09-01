// 群成员触发权的边界锁（2026-09-01）
//
// Synqa 定的规则一句话：**要拦的只有除她之外的私聊；群里不拦人。**
// 旧默认正好相反 —— 群白名单只有她一个、两个 allowAll* 默认未设，于是群里
// 除了她谁都叫不醒他。这组测试守的就是"默认必须是开着的"。
import assert from 'node:assert/strict';
import test from 'node:test';
import { canTriggerInGroup } from '../src/group-membership.mjs';

const OWNER = ['8668822281'];
const human = (id) => ({ senderId: id, senderIsBot: false });
const bot = (id) => ({ senderId: id, senderIsBot: true });

test('默认（群配置什么都没写）：任何人都能叫醒他', () => {
  assert.equal(canTriggerInGroup(human('8682276666'), {}, OWNER), true, '棠棠这样的朋友');
  assert.equal(canTriggerInGroup(human('99999999'), {}, OWNER), true, '素未谋面的人');
  assert.equal(canTriggerInGroup(human('8668822281'), {}, OWNER), true, 'Synqa 本人');
});

test('默认：任何 bot 也能叫醒他 —— 家人和外面的机一视同仁', () => {
  assert.equal(canTriggerInGroup(bot('8749076573'), {}, OWNER), true, 'Syner');
  assert.equal(canTriggerInGroup(bot('8700716146'), {}, OWNER), true, 'Sephy');
  assert.equal(canTriggerInGroup(bot('8791166014'), {}, OWNER), true, 'Sylux');
  assert.equal(canTriggerInGroup(bot('8913414399'), {}, OWNER), true, '咪豹（别人家的机）');
});

test('这正是 8/22 到 8/31 的旧行为，不能再回去', () => {
  // 旧代码等价于 allowAll* 必须显式 === true 才放行。若哪天有人把判定写回
  // "=== true"，下面这条会变红。
  const legacy = (s) => Boolean(
    OWNER.includes(String(s.senderId))
    || (!s.senderIsBot && undefined === true)
    || (s.senderIsBot && undefined === true),
  );
  assert.equal(legacy(bot('8749076573')), false, '旧行为：Syner 叫不醒他');
  assert.equal(canTriggerInGroup(bot('8749076573'), {}, OWNER), true, '新行为：叫得醒');
});

test('逃生口保留：显式 false 仍能收紧某个群', () => {
  assert.equal(canTriggerInGroup(human('99999999'), { allowAllHumanUsers: false }, OWNER), false);
  assert.equal(canTriggerInGroup(bot('8749076573'), { allowAllBotUsers: false }, OWNER), false);
  // 但 owner 永远进得来，收紧不该把她自己关在门外。
  assert.equal(
    canTriggerInGroup(human('8668822281'), { allowAllHumanUsers: false }, OWNER), true,
    '收紧后 Synqa 本人仍必须能叫醒他',
  );
});

test('群级 allowedUserIds 覆盖桥级名单时，owner 不能被挤掉', () => {
  // 收紧某个群不该让她自己在那个群里叫不动他。旧写法用 || 取其一，
  // 一旦群级配了名单，桥级的 owner 就整个失效 —— 她会把自己关在门外。
  const cfg = { allowedUserIds: ['123'], allowAllHumanUsers: false, allowAllBotUsers: false };
  assert.equal(canTriggerInGroup(human('123'), cfg, OWNER), true, '群级名单里的人');
  assert.equal(canTriggerInGroup(human('99999999'), cfg, OWNER), false, '名单外的人被挡');
  assert.equal(canTriggerInGroup(human('8668822281'), cfg, OWNER), true,
    'Synqa 本人不在群级名单里，但必须仍能叫醒他');
});
