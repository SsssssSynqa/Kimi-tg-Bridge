export function telegramToolMode({ isGroup, privateToolsEnabled }) {
  if (isGroup) return 'read-only';
  return privateToolsEnabled === true ? 'private-tools' : 'read-only';
}
