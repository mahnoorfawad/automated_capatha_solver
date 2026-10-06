// hCaptcha: checkbox frame + challenge frame (image grid, example matching, canvas click tasks).
(() => {
  const CS = globalThis.CaptchaSolver;
  if (!CS || CS.hcaptchaLoaded) return;
  if (!/(^|\.)hcaptcha\.com$/.test(location.hostname)) return;
  CS.hcaptchaLoaded = true;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const frame = new URLSearchParams(location.hash.slice(1)).get('frame');

  // ---------------- checkbox frame ----------------
  if (frame === 'checkbox') {
    let clicking = false;
    const clickBox = async (manual) => {
      if (clicking || (!manual && !(await CS.autoEnabled('solveHcaptcha')))) return;
      const box = await CS.waitFor(() => $('#checkbox'), 15000);
      if (!box || box.getAttribute('aria-checked') === 'true') return;
      clicking = true;
      await CS.humanDelay(900);
      CS.click(box);
      setTimeout(() => (clicking = false), 5000);
    };
    (async () => {
      const box = await CS.waitFor(() => $('#checkbox'), 15000);
      if (!box) return;
      let reported = false;
      new MutationObserver(() => {
        const checked = box.getAttribute('aria-checked') === 'true';
        if (checked && !reported) {
          reported = true;
          CS.send({ type: 'broadcast', payload: { type: 'hcaptchaSolved' } }).catch(() => {});
          CS.toast('hCaptcha solved', 'ok');
          CS.reportSolved('hcaptcha');
        } else if (!checked && reported) {
          reported = false; // expired
          clickBox(false);
        }
      }).observe(box, { attributes: true, attributeFilter: ['aria-checked'] });
    })();
    CS.manualSolvers.push(() => clickBox(true));
    clickBox(false);
    return;
  }

  if (frame !== 'challenge') return;

  // ---------------- challenge frame ----------------
  let running = false;
  let solvedFlag = false;
  let lastHandledSig = '';
  CS.handlers.hcaptchaSolved = () => {
    solvedFlag = true;
  };

  const promptText = () => ($('.prompt-text, h2.prompt-text, .challenge-prompt')?.innerText || '').replace(/\s+/g, ' ').trim();
  const gridTasks = () => {
    const tasks = $$('.task-grid .task-image, .task-grid .task, .task-image').filter(CS.isVisible);
    return [...new Set(tasks)].filter((t) => !tasks.some((o) => o !== t && o.contains(t)));
  };
  const mainCanvas = () =>
    $$('canvas')
      .filter(CS.isVisible)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];

  function signature() {
    const first = gridTasks()[0];
    const img = first ? CS.backgroundImageUrl(first.querySelector('.image') || first) : '';
    return `${promptText()}|${img}|${gridTasks().length}|${mainCanvas() ? 'canvas' : ''}`;
  }

  const hasChallenge = () => promptText() && (gridTasks().length || mainCanvas());
  const submitButton = () => $('.button-submit, .submit-button, [aria-label*="Submit" i], [aria-label*="Next" i], [aria-label*="Verify" i]');

  async function solveGrid(instruction) {
    const tasks = gridTasks();
    const exampleEl = $$('.challenge-example .image, .challenge-example canvas').find(CS.isVisible);
    const example = exampleEl ? await CS.elementImage(exampleEl, { minSize: 224 }).catch(() => null) : null;
    const tiles = await Promise.all(tasks.map((t) => CS.elementImage(t.querySelector('.image') || t, { minSize: 224 })));
    const target = instruction.replace(/^.*?(containing|with|of|showing|that (?:are|is|has|have))\s+(an?\s+)?/i, '').replace(/[.?!]$/, '');
    const selected = await CS.classifyTiles({ tiles, target, instruction, example });
    for (const i of selected) {
      CS.click(tasks[i]);
      await CS.humanDelay(300);
    }
    return selected.length;
  }

  async function solveCanvas(instruction) {
    const canvas = mainCanvas();
    const raw = await CS.elementImage(canvas, { maxSize: 1000 });
    const image = await CS.withCoordinateGrid(raw);
    const { points } = await CS.task('locate', { image, instruction });
    const r = canvas.getBoundingClientRect();
    for (const p of points) {
      CS.click(canvas, { x: r.left + (p.x / 100) * r.width, y: r.top + (p.y / 100) * r.height });
      await CS.humanDelay(400);
    }
    return points.length;
  }

  async function outcome(prevSig, timeout = 6000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      await CS.sleep(300);
      if (solvedFlag) return 'solved';
      if (signature() !== prevSig) return 'changed';
    }
    return 'idle';
  }

  async function solveLoop(manual = false) {
    if (running) return;
    const s = await CS.getSettings();
    if (!manual && !(s.enabled && s.autoSolve && s.solveHcaptcha)) return;
    running = true;
    solvedFlag = false;
    try {
      for (let round = 0; round < s.maxRounds * 2 && !solvedFlag; round++) {
        if (!(await CS.waitFor(hasChallenge, 5000))) break;
        await CS.sleep(800); // images fade in
        const instruction = promptText();
        const sig = signature();
        CS.toast(`hCaptcha: ${instruction}`);
        if (gridTasks().length) await solveGrid(instruction);
        else await solveCanvas(instruction);
        await CS.humanDelay(700);
        const btn = submitButton();
        if (btn) CS.click(btn);
        const result = await outcome(sig);
        await CS.log('hCaptcha round', round, result);
        if (result !== 'changed') break;
      }
    } catch (e) {
      CS.reportFailed('hCaptcha', e.message);
    } finally {
      lastHandledSig = signature();
      running = false;
    }
  }

  CS.manualSolvers.push(() => solveLoop(true));
  const onMutation = CS.debounce(() => {
    if (running || !hasChallenge() || signature() === lastHandledSig) return;
    solveLoop(false);
  }, 900);
  const start = () => new MutationObserver(onMutation).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
