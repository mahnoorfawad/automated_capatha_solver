// Google reCAPTCHA v2: checkbox (anchor frame) + image-grid / audio challenge (bframe).
(() => {
  const CS = globalThis.CaptchaSolver;
  if (!CS || CS.recaptchaLoaded) return;
  if (!/(^|\.)(google\.com|recaptcha\.net)$/.test(location.hostname) || !location.pathname.includes('/recaptcha/')) return;
  CS.recaptchaLoaded = true;

  const $ = (sel) => document.querySelector(sel);
  const isAnchor = location.pathname.includes('/anchor');
  const isBframe = location.pathname.includes('/bframe');

  // ---------------- checkbox frame ----------------
  if (isAnchor) {
    if (new URLSearchParams(location.search).get('size') === 'invisible') return;
    let clicking = false;

    const clickBox = async (manual) => {
      if (clicking || (!manual && !(await CS.autoEnabled('solveRecaptcha')))) return;
      const box = await CS.waitFor(() => $('#recaptcha-anchor'), 15000);
      if (!box || box.getAttribute('aria-checked') === 'true') return;
      clicking = true;
      await CS.humanDelay(900);
      CS.click(box);
      setTimeout(() => (clicking = false), 5000);
    };

    const watch = async () => {
      const box = await CS.waitFor(() => $('#recaptcha-anchor'), 15000);
      if (!box) return;
      let reported = false;
      new MutationObserver(() => {
        if (box.getAttribute('aria-checked') === 'true' && !reported) {
          reported = true;
          CS.send({ type: 'broadcast', payload: { type: 'recaptchaSolved' } }).catch(() => {});
          CS.toast('reCAPTCHA solved', 'ok');
          CS.reportSolved('recaptcha');
        }
        if (box.classList.contains('recaptcha-checkbox-expired')) {
          reported = false;
          clickBox(false);
        }
      }).observe(box, { attributes: true, attributeFilter: ['aria-checked', 'class'] });
    };

    CS.manualSolvers.push(() => clickBox(true));
    watch();
    clickBox(false);
    return;
  }

  if (!isBframe) return;

  // ---------------- challenge frame ----------------
  let running = false;
  let solvedFlag = false;
  let lastHandledSig = '';

  CS.handlers.recaptchaSolved = () => {
    solvedFlag = true;
  };

  const visible = (sel) => {
    const el = $(sel);
    return el && CS.isVisible(el) ? el : null;
  };

  function challenge() {
    if (visible('.rc-doscaptcha-header')) return { kind: 'blocked' };
    const table = visible('table[class*="rc-imageselect-table"]');
    if (table) return { kind: 'image', table };
    if (visible('#audio-response')) return { kind: 'audio' };
    return null;
  }

  function signature() {
    const img = $('table[class*="rc-imageselect-table"] img');
    const desc = $('.rc-imageselect-desc-no-canonical, .rc-imageselect-desc');
    const audio = $('#audio-source');
    return [img?.src, desc?.textContent, audio?.src].join('|');
  }

  const errorVisible = () =>
    ['.rc-imageselect-incorrect-response', '.rc-imageselect-error-select-more', '.rc-imageselect-error-dynamic-more',
      '.rc-imageselect-error-select-something', '.rc-audiochallenge-error-message']
      .some((sel) => {
        const el = $(sel);
        return el && CS.isVisible(el) && el.textContent.trim();
      });

  const tileImg = (td) => td.querySelector('img');

  async function solveImage() {
    const { table } = challenge();
    const desc = $('.rc-imageselect-desc-no-canonical, .rc-imageselect-desc');
    const instruction = desc.innerText.replace(/\s+/g, ' ').trim();
    const target = desc.querySelector('strong')?.innerText.trim() || '';
    const rows = table.rows.length;
    const cols = table.rows[0].cells.length;
    const tiles = [...table.querySelectorAll('td')];
    const payload = await CS.loadImage(tileImg(tiles[0]).src);
    const isSquare = rows * cols >= 16 || table.className.includes('44');

    CS.toast(`reCAPTCHA: looking for "${target || instruction}"…`);
    const tileImages = await CS.splitImage(payload, rows, cols);
    const fullImage = CS.rasterize(payload, { minSize: 450 });
    const selected = await CS.classifyTiles({ tiles: tileImages, fullImage, rows, cols, target, instruction, isSquare });
    await CS.log('reCAPTCHA selected', selected);

    let pending = selected;
    let prevSrc = new Map(pending.map((i) => [i, tileImg(tiles[i]).src]));
    for (const i of pending) {
      CS.click(tiles[i]);
      await CS.humanDelay(350);
    }

    // Dynamic challenges replace clicked tiles with fresh images; keep going until none match.
    for (let iter = 0; iter < 10 && pending.length; iter++) {
      await CS.sleep(600);
      const dynamic = pending.some((i) => tiles[i].classList.contains('rc-imageselect-dynamic-selected')) || table.querySelector('img.rc-image-tile-11');
      if (!dynamic) break;
      const ready = await CS.waitFor(
        () =>
          pending.every((i) => {
            const img = tileImg(tiles[i]);
            return img && img.src !== prevSrc.get(i) && img.complete && img.naturalWidth &&
              !tiles[i].classList.contains('rc-imageselect-dynamic-selected');
          }),
        12000,
        250
      );
      if (!ready) break;
      await CS.sleep(400);
      const fresh = await Promise.all(pending.map(async (i) => CS.rasterize(await CS.loadImage(tileImg(tiles[i]).src), { minSize: 224 })));
      const hits = await CS.classifyTiles({ tiles: fresh, target, instruction });
      const next = hits.map((h) => pending[h]);
      prevSrc = new Map(next.map((i) => [i, tileImg(tiles[i]).src]));
      for (const i of next) {
        CS.click(tiles[i]);
        await CS.humanDelay(350);
      }
      pending = next;
    }

    await CS.humanDelay(600);
    CS.click($('#recaptcha-verify-button'));
  }

  async function solveAudio() {
    const src = $('#audio-source')?.src || $('.rc-audiochallenge-tdownload-link')?.href;
    if (!src) throw new Error('audio source not found');
    CS.toast('reCAPTCHA: transcribing audio…');
    const { text } = await CS.send({ type: 'transcribe', url: src });
    const answer = text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
    if (!answer) throw new Error('empty transcription');
    await CS.typeInto($('#audio-response'), answer);
    await CS.humanDelay(500);
    CS.click($('#recaptcha-verify-button'));
  }

  /** Resolves to 'solved' | 'changed' | 'error' | 'idle' after a verify click. */
  async function outcome(prevSig, timeout = 7000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      await CS.sleep(300);
      if (solvedFlag) return 'solved';
      if (challenge()?.kind === 'blocked') return 'blocked';
      if (signature() !== prevSig) return 'changed';
      if (errorVisible()) return 'error';
    }
    return 'idle';
  }

  async function solveLoop(manual = false) {
    if (running) return;
    const s = await CS.getSettings();
    if (!manual && !(s.enabled && s.autoSolve && s.solveRecaptcha)) return;
    running = true;
    solvedFlag = false;
    try {
      for (let round = 0; round < s.maxRounds && !solvedFlag; round++) {
        let ch = challenge();
        if (!ch) break;
        if (ch.kind === 'blocked') throw new Error('Google is rate-limiting this browser ("Try again later")');

        if (ch.kind === 'image' && s.recaptchaMode === 'audio' && s.sttProvider !== 'none') {
          CS.click($('#recaptcha-audio-button'));
          await CS.waitFor(() => challenge()?.kind !== 'image', 6000);
          continue;
        }

        const sig = signature();
        if (ch.kind === 'audio') await solveAudio();
        else await solveImage();

        const result = await outcome(sig);
        await CS.log('reCAPTCHA round', round, result);
        if (result === 'solved' || result === 'idle') break;
        if (result === 'blocked') throw new Error('Google is rate-limiting this browser ("Try again later")');
        if (result === 'error' && signature() === sig) {
          CS.click($('#recaptcha-reload-button'));
          await CS.waitFor(() => signature() !== sig, 6000);
        }
      }
    } catch (e) {
      CS.reportFailed('reCAPTCHA', e.message);
    } finally {
      lastHandledSig = signature();
      running = false;
    }
  }

  CS.manualSolvers.push(() => solveLoop(true));

  // Start whenever a new challenge is rendered (checkbox click, invisible reCAPTCHA, reload).
  const onMutation = CS.debounce(() => {
    if (running || !challenge()) return;
    if (signature() === lastHandledSig) return;
    solveLoop(false);
  }, 700);
  const start = () =>
    new MutationObserver(onMutation).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'class'] });
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
