import '../shared/defaults.js';
import { setConcurrency, testConnection, transcribe } from './llm.js';
import * as tasks from './tasks.js';

const DEFAULTS = globalThis.CS_DEFAULTS;
const TASKS = {
  ocr: tasks.ocr,
  classifyTile: tasks.classifyTile,
  classifyGrid: tasks.classifyGrid,
  locate: tasks.locate,
  question: tasks.question,
  visual: tasks.visual,
};

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...settings };
  setConcurrency(s.concurrency);
  return s;
}

async function appendLog(entry) {
  const { log = [] } = await chrome.storage.local.get('log');
  log.unshift({ time: Date.now(), ...entry });
  await chrome.storage.local.set({ log: log.slice(0, 40) });
}

async function recordSolved(kind, detail, tabId) {
  const { stats = {} } = await chrome.storage.local.get('stats');
  stats[kind] = (stats[kind] || 0) + 1;
  stats.total = (stats.total || 0) + 1;
  await chrome.storage.local.set({ stats });
  await appendLog({ ok: true, kind, detail });
  if (tabId !== undefined) {
    chrome.action.setBadgeBackgroundColor({ color: '#16a34a', tabId });
    chrome.action.setBadgeText({ text: '✓', tabId });
  }
}

function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function fetchAsDataUrl(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Image fetch failed: HTTP ${res.status}`);
  const type = res.headers.get('content-type')?.split(';')[0] || 'image/png';
  return `data:${type};base64,${bufferToBase64(await res.arrayBuffer())}`;
}

/** Finds the frameId of a child frame from its URL (used to click inside cross-origin iframes). */
async function frameIdForUrl(tabId, frameUrl) {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  const strip = (u) => u.split('#')[0];
  const hit = frames.find((f) => f.url === frameUrl) || frames.find((f) => strip(f.url) === strip(frameUrl));
  return hit?.frameId;
}

async function sendToActiveTab(message, options) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  await chrome.tabs.sendMessage(tab.id, message, options).catch(() => {});
  return tab.id;
}

const handlers = {
  async task({ task, payload }) {
    const fn = TASKS[task];
    if (!fn) throw new Error(`Unknown task: ${task}`);
    return fn(payload, await getSettings());
  },

  async transcribe({ url }) {
    return { text: await transcribe(url, await getSettings()) };
  },

  async fetchImage({ url }) {
    return { dataUrl: await fetchAsDataUrl(url) };
  },

  async captureTab(_msg, sender) {
    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
    return { dataUrl };
  },

  // Screenshot for an element inside a child frame: the top frame reports where that iframe sits.
  async captureFrame(_msg, sender) {
    const frame = await chrome.tabs.sendMessage(sender.tab.id, { type: 'iframeRect', url: sender.url }, { frameId: 0 });
    if (!frame?.found) throw new Error('Could not locate the captcha iframe on the page');
    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
    return { dataUrl, frame };
  },

  async toast({ message, level }, sender) {
    if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, { type: 'toast', message, level }, { frameId: 0 }).catch(() => {});
    return {};
  },

  async solved({ kind, detail }, sender) {
    await recordSolved(kind, detail, sender.tab?.id);
    return {};
  },

  async failed({ kind, error }) {
    await appendLog({ ok: false, kind, detail: error });
    return {};
  },

  // Relayed to every frame in the tab so the challenge frame knows the checkbox turned green.
  async broadcast({ payload }, sender) {
    if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, payload).catch(() => {});
    return {};
  },

  // Top frame asks us to deliver an action to a child frame identified by URL.
  async frameAction({ frameUrl, action }, sender) {
    const frameId = await frameIdForUrl(sender.tab.id, frameUrl);
    if (frameId === undefined) throw new Error('Could not find the target iframe');
    return chrome.tabs.sendMessage(sender.tab.id, action, { frameId });
  },

  async testConnection() {
    return testConnection(await getSettings());
  },

  async solveNow() {
    await sendToActiveTab({ type: 'solve' });
    return {};
  },

  async visualSolve() {
    await sendToActiveTab({ type: 'visualSolve' }, { frameId: 0 });
    return {};
  },
};

// Ollama answers 403 to unknown Origins (including chrome-extension://). Strip the Origin
// header on our own requests to the configured Ollama URL so no OLLAMA_ORIGINS setup is needed.
const OLLAMA_RULE_ID = 1;
async function syncOllamaOriginRule() {
  const { ollamaUrl } = await getSettings();
  let origin;
  try {
    origin = new URL(ollamaUrl).origin;
  } catch {
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [OLLAMA_RULE_ID],
    addRules: [
      {
        id: OLLAMA_RULE_ID,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
        condition: { urlFilter: `|${origin}/`, initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest', 'other'] },
      },
    ],
  });
}
syncOllamaOriginRule().catch((e) => console.warn('Ollama origin rule failed', e));
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) syncOllamaOriginRule().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender)
    .then((res) => sendResponse(res ?? {}))
    .catch((e) => sendResponse({ error: e?.message || String(e) }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'cs-image', title: 'Solve CAPTCHA in this image', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'cs-page', title: 'Solve CAPTCHAs on this page', contexts: ['page', 'frame'] });
    chrome.contextMenus.create({ id: 'cs-visual', title: 'Visual solve (screenshot + AI)', contexts: ['page', 'frame', 'image'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const send = (msg, opts) => chrome.tabs.sendMessage(tab.id, msg, opts).catch(() => {});
  if (info.menuItemId === 'cs-image') send({ type: 'solveImage', srcUrl: info.srcUrl }, { frameId: info.frameId });
  if (info.menuItemId === 'cs-page') send({ type: 'solve' });
  if (info.menuItemId === 'cs-visual') send({ type: 'visualSolve' }, { frameId: 0 });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'solve-captcha') sendToActiveTab({ type: 'solve' });
  if (command === 'visual-solve') sendToActiveTab({ type: 'visualSolve' }, { frameId: 0 });
});
