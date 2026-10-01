// LLM + speech-to-text providers. All network calls to models happen here, in
// the service worker, so content scripts never need CORS access to the model.

const OLLAMA_CORS_HINT =
  'Ollama rejected the request (HTTP 403). Restart Ollama with OLLAMA_ORIGINS="chrome-extension://*" ' +
  '(see README) so it accepts requests from the extension.';

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async run(fn) {
    if (this.active >= this.max) await new Promise((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

let semaphore = new Semaphore(3);
export function setConcurrency(n) {
  if (n !== semaphore.max) semaphore = new Semaphore(Math.max(1, n | 0));
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs / 1000}s: ${url}`);
    throw new Error(`Network error calling ${url}: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function errorText(res) {
  const body = await res.text().catch(() => '');
  return `HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ''}`;
}

const stripDataPrefix = (dataUrl) => dataUrl.replace(/^data:[^;]+;base64,/, '');

/** Removes reasoning blocks some models emit before the answer. */
function cleanOutput(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

async function ollamaChat({ prompt, images, json, maxTokens }, s) {
  const url = `${s.ollamaUrl.replace(/\/+$/, '')}/api/chat`;
  const body = {
    model: s.ollamaModel,
    stream: false,
    keep_alive: '15m',
    options: { temperature: 0, num_predict: maxTokens },
    messages: [{ role: 'user', content: prompt, images: images.map(stripDataPrefix) }],
  };
  if (json) body.format = 'json';
  const res = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    s.requestTimeoutMs
  );
  if (res.status === 403) throw new Error(OLLAMA_CORS_HINT);
  if (!res.ok) throw new Error(`Ollama: ${await errorText(res)}`);
  const data = await res.json();
  return data.message?.content ?? '';
}

async function openaiChat({ prompt, images, maxTokens }, { baseUrl, apiKey, model, timeoutMs, label }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const content = [{ type: 'text', text: prompt }, ...images.map((u) => ({ type: 'image_url', image_url: { url: u } }))];
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: images.length ? content : prompt }],
      }),
    },
    timeoutMs
  );
  if (!res.ok) throw new Error(`${label}: ${await errorText(res)}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message?.content;
  return Array.isArray(msg) ? msg.map((p) => p.text || '').join('') : msg ?? '';
}

/**
 * Sends a prompt (optionally with images as data URLs) to the configured model.
 * @returns {Promise<string>} the model's text reply
 */
export async function chat({ prompt, images = [], json = false, maxTokens = 256 }, s) {
  return semaphore.run(async () => {
    let out;
    switch (s.provider) {
      case 'ollama':
        out = await ollamaChat({ prompt, images, json, maxTokens }, s);
        break;
      case 'huggingface':
        if (!s.hfToken) throw new Error('Hugging Face token is not set (open the extension popup).');
        out = await openaiChat(
          { prompt, images, maxTokens },
          { baseUrl: s.hfBaseUrl, apiKey: s.hfToken, model: s.hfModel, timeoutMs: s.requestTimeoutMs, label: 'Hugging Face' }
        );
        break;
      case 'openai':
        out = await openaiChat(
          { prompt, images, maxTokens },
          { baseUrl: s.openaiUrl, apiKey: s.openaiKey, model: s.openaiModel, timeoutMs: s.requestTimeoutMs, label: 'OpenAI-compatible' }
        );
        break;
      default:
        throw new Error(`Unknown provider: ${s.provider}`);
    }
    return cleanOutput(out);
  });
}

/** Transcribes an audio file (fetched by URL) to text. */
export async function transcribe(audioUrl, s) {
  if (s.sttProvider === 'none') throw new Error('Speech-to-text is disabled. Pick a provider in the popup.');
  const audioRes = await fetchWithTimeout(audioUrl, { credentials: 'include' }, 30000);
  if (!audioRes.ok) throw new Error(`Audio download failed: ${await errorText(audioRes)}`);
  const audio = await audioRes.blob();

  if (s.sttProvider === 'huggingface') {
    if (!s.hfToken) throw new Error('Hugging Face token is not set.');
    const url = `https://router.huggingface.co/hf-inference/models/${s.hfSttModel}`;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.hfToken}`, 'Content-Type': audio.type || 'audio/mpeg' },
        body: audio,
      },
      s.requestTimeoutMs
    );
    if (!res.ok) throw new Error(`Hugging Face STT: ${await errorText(res)}`);
    const data = await res.json();
    return (Array.isArray(data) ? data[0]?.text : data.text) || '';
  }

  if (s.sttProvider === 'openai') {
    const form = new FormData();
    form.append('file', audio, 'audio.mp3');
    form.append('model', s.openaiSttModel);
    const headers = s.openaiKey ? { Authorization: `Bearer ${s.openaiKey}` } : {};
    const res = await fetchWithTimeout(
      `${s.openaiUrl.replace(/\/+$/, '')}/audio/transcriptions`,
      { method: 'POST', headers, body: form },
      s.requestTimeoutMs
    );
    if (!res.ok) throw new Error(`OpenAI-compatible STT: ${await errorText(res)}`);
    return (await res.json()).text || '';
  }

  throw new Error(`Unknown STT provider: ${s.sttProvider}`);
}

/** Quick health check used by the popup's "Test connection" button. */
export async function testConnection(s) {
  if (s.provider === 'ollama') {
    const res = await fetchWithTimeout(`${s.ollamaUrl.replace(/\/+$/, '')}/api/tags`, {}, 8000);
    if (res.status === 403) throw new Error(OLLAMA_CORS_HINT);
    if (!res.ok) throw new Error(`Ollama: ${await errorText(res)}`);
    const { models = [] } = await res.json();
    const names = models.map((m) => m.name);
    const wanted = s.ollamaModel.includes(':') ? s.ollamaModel : `${s.ollamaModel}:latest`;
    if (!names.includes(wanted)) {
      return {
        ok: false,
        message: `Ollama is running but model "${s.ollamaModel}" is not pulled. Run: ollama pull ${s.ollamaModel}` +
          (names.length ? `\nInstalled: ${names.join(', ')}` : ''),
      };
    }
  }
  const reply = await chat({ prompt: 'Reply with the single word: ready', maxTokens: 10 }, s);
  return { ok: true, message: `Model replied: "${reply.slice(0, 60)}"` };
}
