import fs from 'node:fs';

// Faithful image-to-text transcription for a text-only backend model, copied
// from the Syrah bridge recipe: a vision model describes what is visible, the
// description is injected into the prompt, and the main model never pretends
// to have seen pixels it did not. The transcriber is a tool, not a persona.
const TRANSCRIBE_INSTRUCTION =
  '你是视觉转写器，不是对话人格。请忠实描述这些图片中可见的对象、人物、界面、颜色、布局与文字；'
  + '逐字转写清晰可辨的文字，无法确定处明确写“不确定”。不要替用户回答问题，不要补造画面外信息。';

// config.vision: { model, baseUrl, apiKeyFile, apiKeyVar, timeoutMs? }
// The API key lives in an env-style file (KEY=value) outside the config so the
// config can be shared in logs without leaking credentials.
export function loadVisionConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const model = String(raw.model || '').trim();
  const baseUrl = String(raw.baseUrl || '').trim().replace(/\/$/, '');
  if (!model || !baseUrl) return null;

  let apiKey = '';
  if (raw.apiKeyFile && raw.apiKeyVar) {
    try {
      const content = fs.readFileSync(raw.apiKeyFile, 'utf8');
      const match = content.match(new RegExp(`^${raw.apiKeyVar}=(.+)$`, 'm'));
      apiKey = match ? match[1].trim() : '';
    } catch {
      apiKey = '';
    }
  }
  if (!apiKey) return null;

  return {
    model,
    baseUrl,
    apiKey,
    timeoutMs: Number(raw.timeoutMs) > 0 ? Number(raw.timeoutMs) : 90000,
  };
}

function guessMimeType(imagePath, declared) {
  if (declared) return declared;
  const lower = String(imagePath || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

// images: bridge attachment records ({ path, mimeType?, ... }).
// Resolves to the transcription text; throws on any failure so the caller can
// degrade honestly instead of publishing an empty or fabricated description.
export async function transcribeImages(images, vision, { userText = '', log = () => {} } = {}) {
  const readable = (images || []).filter((image) => image?.path && fs.existsSync(image.path));
  if (!readable.length) throw new Error('没有可读取的图片文件');

  const content = [
    {
      type: 'text',
      text: TRANSCRIBE_INSTRUCTION + (userText ? `\n用户随图文字：${String(userText).slice(0, 500)}` : ''),
    },
    ...readable.map((image) => ({
      type: 'image_url',
      image_url: {
        url: `data:${guessMimeType(image.path, image.mimeType)};base64,${fs.readFileSync(image.path).toString('base64')}`,
      },
    })),
  ];

  const response = await fetch(`${vision.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${vision.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: vision.model,
      messages: [{ role: 'user', content }],
      max_tokens: 3000,
    }),
    signal: AbortSignal.timeout(vision.timeoutMs),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error || !data?.choices?.[0]?.message) {
    throw new Error(data?.error?.message || `视觉转写失败（HTTP ${response.status}）`);
  }

  const raw = data.choices[0].message.content;
  const description = Array.isArray(raw)
    ? raw.map((item) => (typeof item === 'string' ? item : item?.text || '')).join('\n').trim()
    : String(raw || '').trim();
  if (!description) throw new Error('视觉模型返回空转写');

  log(`vision transcribe ok model=${vision.model} images=${readable.length} chars=${description.length}`);
  return description;
}
