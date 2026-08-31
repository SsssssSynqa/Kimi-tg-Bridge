export function splitTelegramText(text, limit = 4000, emptyText = '(no sendable text)') {
  const chunks = [];
  let rest = String(text || '');

  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < Math.floor(limit * 0.6)) cut = limit;
    // JS indices count UTF-16 code units. Never separate a high surrogate from
    // its low surrogate at Telegram's chunk boundary.
    if (cut > 0 && cut < rest.length) {
      const left = rest.charCodeAt(cut - 1);
      const right = rest.charCodeAt(cut);
      if (left >= 0xD800 && left <= 0xDBFF && right >= 0xDC00 && right <= 0xDFFF) cut -= 1;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }

  if (rest) chunks.push(rest);
  return chunks.length ? chunks : [emptyText];
}
