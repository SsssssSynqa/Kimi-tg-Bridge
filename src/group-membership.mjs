// 群成员能不能叫醒他 —— 2026-09-01 Synqa 定的边界。
//
// 她的原话：「这种东西不是应该默认每个群都有吗，不光是家人，他到了外面的群里
// 功能应该一样啊，外面的人和机应该也能叫醒他才对！要拦的只有除了我之外的私聊啊！」
//
// 旧默认是反的：群白名单只有她一个人，两个 allowAll* 默认未设，于是群里
// **除了她谁都叫不醒他** —— 家人不行，棠棠咪豹 West 这些朋友也不行。
// 日志里 "ignore unauthorized group member" 从 8/22 基线重写起每天几百条，
// 8/30 峰值 1183 条；同期会客室里 Syner 发过 2186 条、修理铺子 1215 条，
// 桥原始都收到、一条都没进他视野。
//
// 现在群里默认全开。**要不要开口是另一回事** —— 那由 requireMention、唤醒词、
// 连发上限和他自己的判断把关；这里只决定"这条消息够不够格送到他面前"。
// 显式 false 仍可收紧（逃生口保留，但不再是默认）。
// 私聊那道门（allowedUserIds）与此无关，那道才是真该拦的。

/**
 * @param {{senderId: string|number, senderIsBot: boolean}} sender
 * @param {{allowedUserIds?: Array, allowAllHumanUsers?: boolean, allowAllBotUsers?: boolean}} groupConfig
 * @param {Array} fallbackAllowedUserIds 桥级 allowedUserIds（通常只有 owner）
 */
export function canTriggerInGroup(sender, groupConfig = {}, fallbackAllowedUserIds = []) {
  // 桥级 allowedUserIds（owner）永远并进来，不被群级名单挤掉：
  // 给某个群单配 allowedUserIds 又关掉 allowAll* 时，旧写法会把她自己
  // 关在门外 —— 收紧一个群不该让她在那个群里叫不动他。
  const allowed = new Set([
    ...(fallbackAllowedUserIds || []).map(String),
    ...(groupConfig.allowedUserIds || []).map(String),
  ]);
  if (allowed.has(String(sender?.senderId ?? ''))) return true;
  return sender?.senderIsBot
    ? groupConfig.allowAllBotUsers !== false
    : groupConfig.allowAllHumanUsers !== false;
}
