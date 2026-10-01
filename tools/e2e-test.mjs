// End-to-end test: launches Chrome with the extension, opens the local playground,
// lets the extension solve every captcha, then presses each "Check" button.
//
// Usage: node tools/e2e-test.mjs [--model qwen2.5vl:7b] [--headed]
// Requires: Chrome, Python (for the static server), and Ollama running with the model pulled.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : null;
const headed = args.includes('--headed');
const PORT = 8765;
const CHROME =
  process.env.CHROME_PATH ||
  {
    win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  }[process.platform] ||
  'google-chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- static server for test-pages ----
const server = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'http.server', String(PORT)], {
  cwd: join(root, 'test-pages'),
  stdio: 'ignore',
});

// ---- Chrome over a CDP pipe (fd 3 = to Chrome, fd 4 = from Chrome) ----
const profile = mkdtempSync(join(tmpdir(), 'captcha-e2e-'));
const chrome = spawn(
  CHROME,
  [
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    ...(headed ? [] : ['--headless=new']),
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
);

let nextId = 1;
const pending = new Map();
let buffer = '';
chrome.stdio[4].on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\0')) !== -1) {
    const msg = JSON.parse(buffer.slice(0, idx));
    buffer = buffer.slice(idx + 1);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: ok, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : ok(msg.result);
    }
  }
});
function cdp(method, params = {}, sessionId) {
  const id = nextId++;
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + '\0');
  return new Promise((ok, reject) => pending.set(id, { resolve: ok, reject }));
}

async function evaluate(sessionId, expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

let exitCode = 1;
try {
  await sleep(1500);
  const { id: extId } = await cdp('Extensions.loadUnpacked', { path: join(root, 'extension') });
  console.log(`Loaded extension ${extId}`);

  // Configure settings through the extension's own storage.
  if (model) {
    const { targetId } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/src/popup/popup.html` });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await sleep(800);
    await evaluate(sessionId, `chrome.storage.local.set({ settings: { ollamaModel: ${JSON.stringify(model)}, debug: true } })`);
    await cdp('Target.closeTarget', { targetId });
    console.log(`Model set to ${model}`);
  }

  const { targetId } = await cdp('Target.createTarget', { url: `http://localhost:${PORT}/` });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Page.bringToFront', {}, sessionId);

  // Wait until every input is filled (or time out).
  const deadline = Date.now() + 5 * 60 * 1000;
  let state;
  while (Date.now() < deadline) {
    await sleep(3000);
    state = await evaluate(
      sessionId,
      `[...document.querySelectorAll('form')].map(f => ({ kind: f.dataset.kind, value: f.querySelector('input').value }))`
    ).catch(() => null);
    if (state && state.every((s) => s.value)) break;
  }
  await sleep(1500);

  const results = await evaluate(
    sessionId,
    `[...document.querySelectorAll('form')].map(f => {
       f.requestSubmit();
       return { kind: f.dataset.kind, value: f.querySelector('input').value, result: f.querySelector('.result').textContent };
     })`
  );
  console.table(results);

  // Print the extension's activity log (errors from the model calls show up here).
  const popup = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/src/popup/popup.html` });
  const popupSession = (await cdp('Target.attachToTarget', { targetId: popup.targetId, flatten: true })).sessionId;
  await sleep(800);
  const log = await evaluate(popupSession, `chrome.storage.local.get('log').then(r => (r.log || []).map(e => (e.ok ? 'ok   ' : 'FAIL ') + e.kind + ': ' + e.detail))`);
  console.log('Extension log:\n  ' + (log.join('\n  ') || '(empty)'));

  const passed = results.filter((r) => r.result.startsWith('✓')).length;
  console.log(`${passed}/${results.length} captchas solved correctly`);
  exitCode = passed === results.length ? 0 : 1;
} catch (e) {
  console.error(e);
} finally {
  chrome.kill();
  server.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Chrome may still hold files */
  }
  process.exit(exitCode);
}
