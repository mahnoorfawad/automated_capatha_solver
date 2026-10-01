const DEFAULTS = globalThis.CS_DEFAULTS;
const fields = [...document.querySelectorAll('[data-key]')];
let settings = { ...DEFAULTS };

function readField(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') return Number(el.value) || DEFAULTS[el.dataset.key];
  return el.value.trim();
}

function writeField(el, value) {
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value ?? '';
}

function updateVisibility() {
  for (const el of document.querySelectorAll('[data-show]')) {
    const [key, value] = el.dataset.show.split('=');
    el.hidden = String(settings[key]) !== value;
  }
}

async function load() {
  const { settings: stored = {} } = await chrome.storage.local.get('settings');
  settings = { ...DEFAULTS, ...stored };
  fields.forEach((el) => writeField(el, settings[el.dataset.key]));
  updateVisibility();
}

async function save(changedEl) {
  const key = changedEl.dataset.key;
  settings[key] = readField(changedEl);
  // Keep duplicate inputs for the same key (e.g. HF token) in sync.
  fields.filter((el) => el !== changedEl && el.dataset.key === key).forEach((el) => writeField(el, settings[key]));
  const { settings: stored = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...stored, [key]: settings[key] } });
  updateVisibility();
}

fields.forEach((el) => el.addEventListener('change', () => save(el)));

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (res?.error) throw new Error(res.error);
  return res;
}

document.getElementById('test').addEventListener('click', async (e) => {
  const out = document.getElementById('testResult');
  out.hidden = false;
  out.className = '';
  out.textContent = 'Testing… (the first call can take a while while the model loads)';
  e.target.disabled = true;
  try {
    const res = await send({ type: 'testConnection' });
    out.className = res.ok ? 'ok' : 'err';
    out.textContent = res.message;
  } catch (err) {
    out.className = 'err';
    out.textContent = err.message;
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById('solveNow').addEventListener('click', async () => {
  await send({ type: 'solveNow' }).catch(() => {});
  window.close();
});

document.getElementById('visualSolve').addEventListener('click', async () => {
  await send({ type: 'visualSolve' }).catch(() => {});
  window.close();
});

function renderLog(log = [], stats = {}) {
  const ul = document.getElementById('log');
  ul.replaceChildren(
    ...log.slice(0, 20).map((entry) => {
      const li = document.createElement('li');
      li.className = entry.ok ? 'ok' : 'err';
      const time = document.createElement('time');
      time.textContent = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      li.append(time, `${entry.kind}${entry.detail ? `: ${entry.detail}` : ''}`);
      return li;
    })
  );
  if (!log.length) {
    const li = document.createElement('li');
    li.textContent = 'Nothing yet.';
    ul.append(li);
  }
  const parts = Object.entries(stats)
    .filter(([k]) => k !== 'total')
    .map(([k, v]) => `${k} ${v}`);
  document.getElementById('stats').textContent = stats.total ? `— ${stats.total} solved (${parts.join(', ')})` : '';
}

async function refreshLog() {
  const { log, stats } = await chrome.storage.local.get(['log', 'stats']);
  renderLog(log, stats);
}

document.getElementById('clearLog').addEventListener('click', async () => {
  await chrome.storage.local.set({ log: [], stats: {} });
  refreshLog();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.log || changes.stats) refreshLog();
});

load();
refreshLog();
