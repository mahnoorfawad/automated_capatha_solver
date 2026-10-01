// Image-to-text captchas: distorted letters/numbers in an <img> or <canvas>
// next to a text input. Also serves the "Solve CAPTCHA in this image" context menu.
(() => {
  const CS = globalThis.CaptchaSolver;
  if (!CS || CS.textCaptchaLoaded) return;
  CS.textCaptchaLoaded = true;
  if (/(^|\.)(google\.com|recaptcha\.net|hcaptcha\.com)$/.test(location.hostname) && /recaptcha|captcha\/v1|hcaptcha/.test(location.href)) return;
  if (location.hostname === 'challenges.cloudflare.com') return;

  const IMG_KW = /captcha|securimage|kcaptcha|verif|security.?code|seccode|checkcode|vcode|authcode|imgcode|validat|antispam|anti-spam|randcode|piccode|code\.(php|aspx|jsp|ashx)|turing/i;
  const INPUT_KW = /captcha|security.?code|seccode|verif(y|ication)?.?code|vcode|checkcode|authcode|imgcode|validat|antispam|turing|letters|characters|code.?(shown|above|below|image)|enter.?(the)?.?code|human/i;
  const EXCLUDE_INPUT = /email|e-mail|user(name)?|login|search|phone|tel|zip|postal|coupon|promo|discount|gift|otp|2fa|totp|sms|address|city|card|cvv|cvc|name/i;

  const attrText = (el) =>
    [el.id, el.name, el.className?.baseVal ?? el.className, el.getAttribute?.('alt'), el.getAttribute?.('title'),
      el.getAttribute?.('placeholder'), el.getAttribute?.('aria-label'), el.getAttribute?.('src')]
      .filter(Boolean)
      .join(' ');

  function labelText(input) {
    const parts = [];
    if (input.labels) parts.push(...[...input.labels].map((l) => l.textContent));
    const lb = input.getAttribute('aria-labelledby');
    if (lb) parts.push(...lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || ''));
    const prev = input.previousElementSibling;
    if (prev && prev.textContent.length < 120) parts.push(prev.textContent);
    return parts.join(' ');
  }

  function scoreImage(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 15 || r.width > 600 || r.height > 260) return -1;
    if (r.width / r.height > 10 || r.height / r.width > 3) return -1;
    let score = 0;
    if (IMG_KW.test(attrText(el))) score += 4;
    if (el instanceof HTMLImageElement && /captcha/i.test(el.src)) score += 2;
    if (el.closest('[class*="captcha" i],[id*="captcha" i]')) score += 3;
    return score;
  }

  function scoreInput(input) {
    if (input.type && !['text', 'number', 'tel', 'search', ''].includes(input.type)) return -1;
    if (input.readOnly || input.disabled) return -1;
    const text = `${attrText(input)} ${labelText(input)}`;
    let score = 0;
    if (INPUT_KW.test(text)) score += 4;
    else if (/\bcode\b/i.test(text)) score += 1;
    if (EXCLUDE_INPUT.test(`${input.name} ${input.id} ${input.autocomplete || ''}`) && !/captcha/i.test(text)) score -= 4;
    const max = input.maxLength;
    if (max >= 3 && max <= 10) score += 1;
    if (input.autocomplete === 'off') score += 1;
    if (input.closest('[class*="captcha" i],[id*="captcha" i]')) score += 3;
    return score;
  }

  const distance = (a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const dx = Math.max(0, Math.max(ra.left, rb.left) - Math.min(ra.right, rb.right));
    const dy = Math.max(0, Math.max(ra.top, rb.top) - Math.min(ra.bottom, rb.bottom));
    return Math.hypot(dx, dy);
  };

  /** Finds (image, input) pairs that look like a text captcha. */
  function findPairs() {
    const images = [...document.querySelectorAll('img, canvas')]
      .filter(CS.isVisible)
      .map((el) => ({ el, score: scoreImage(el) }))
      .filter((x) => x.score >= 0);
    const inputs = [...document.querySelectorAll('input, textarea')]
      .filter(CS.isVisible)
      .map((el) => ({ el, score: scoreInput(el) }))
      .filter((x) => x.score >= 0);

    const pairs = [];
    const usedImages = new Set();
    for (const input of inputs) {
      let best = null;
      for (const img of images) {
        if (usedImages.has(img.el)) continue;
        const d = distance(img.el, input.el);
        if (d > 350) continue;
        let score = img.score + input.score;
        const imgForm = img.el.closest('form');
        const inputForm = input.el.closest('form');
        if (imgForm && inputForm && imgForm !== inputForm) continue;
        if (imgForm && imgForm === inputForm) score += 2;
        if (d < 120) score += 1;
        if (img.score <= 0 && input.score < 4) continue;
        if (score >= 5 && (!best || score > best.score || (score === best.score && d < best.d))) best = { img: img.el, input: input.el, score, d };
      }
      if (best) {
        usedImages.add(best.img);
        pairs.push(best);
      }
    }
    return pairs;
  }

  function imageKey(el) {
    if (el instanceof HTMLImageElement) return el.currentSrc || el.src;
    try {
      const d = el.toDataURL();
      return `canvas:${d.length}:${d.slice(-48)}`;
    } catch {
      return `canvas:${el.width}x${el.height}`;
    }
  }
  const inFlight = new WeakSet();

  async function solvePair({ img, input }, { force = false } = {}) {
    const key = imageKey(img);
    if (inFlight.has(input)) return;
    if (!force && input.dataset.csSolvedFor === key) return;
    if (!force && input.value && input.dataset.csFilled !== '1') return; // user typed something
    inFlight.add(input);
    try {
      const s = await CS.getSettings();
      const digitsOnly =
        input.type === 'number' || input.inputMode === 'numeric' || /^\^?(\\d|\[0-9\])/.test(input.pattern || '');
      const maxLength = input.maxLength > 0 && input.maxLength < 20 ? input.maxLength : undefined;
      const image = await CS.elementImage(img, { minSize: 100, maxSize: 800 });
      const { text } = await CS.task('ocr', { image, digitsOnly, maxLength });
      if (!text) throw new Error('model returned no text');
      await CS.typeInto(input, text);
      input.dataset.csSolvedFor = key;
      input.dataset.csFilled = '1';
      CS.toast(`Text captcha filled: ${text}`, 'ok');
      CS.reportSolved('text', text);
      if (s.autoSubmit) submitNear(input);
    } catch (e) {
      CS.reportFailed('Text captcha', e.message);
    } finally {
      inFlight.delete(input);
    }
  }

  function submitNear(input) {
    const form = input.closest('form');
    const btn = form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    setTimeout(() => (btn ? CS.click(btn) : form?.requestSubmit?.()), CS.rand(500, 1200));
  }

  // Re-solve when the captcha image is refreshed.
  const watched = new WeakSet();
  function watchImage(pair) {
    if (watched.has(pair.img)) return;
    watched.add(pair.img);
    pair.img.addEventListener('load', async () => {
      if (!(await CS.autoEnabled('solveText'))) return;
      if (pair.input.dataset.csFilled === '1') CS.setInputValue(pair.input, '');
      solvePair(pair, { force: true });
    });
  }

  async function scan({ manual = false } = {}) {
    if (!manual && !(await CS.autoEnabled('solveText'))) return 0;
    const pairs = findPairs();
    for (const p of pairs) {
      watchImage(p);
      await solvePair(p, { force: manual });
    }
    return pairs.length;
  }

  CS.manualSolvers.push(() => scan({ manual: true }));

  // ----- context menu: "Solve CAPTCHA in this image" -----
  let lastContextTarget = null;
  document.addEventListener('contextmenu', (e) => (lastContextTarget = e.target), true);
  let lastFocusedInput = null;
  document.addEventListener('focusin', (e) => {
    if (e.target.matches?.('input, textarea')) lastFocusedInput = e.target;
  });

  CS.handlers.solveImage = async ({ srcUrl }) => {
    const img =
      (lastContextTarget instanceof HTMLImageElement && lastContextTarget) ||
      [...document.images].find((i) => i.currentSrc === srcUrl || i.src === srcUrl);
    if (!img) return CS.reportFailed('Image captcha', 'Could not find that image on the page');
    CS.toast('Reading captcha image…');
    let input = findPairs().find((p) => p.img === img)?.input;
    if (!input) {
      const candidates = [...document.querySelectorAll('input, textarea')].filter((i) => CS.isVisible(i) && scoreInput(i) >= 0);
      input = candidates.sort((a, b) => distance(a, img) - distance(b, img))[0];
      if (input && distance(input, img) > 400) input = null;
    }
    input = input || lastFocusedInput;
    if (input) return solvePair({ img, input }, { force: true });
    try {
      const { text } = await CS.task('ocr', { image: await CS.elementImage(img, { minSize: 100, maxSize: 800 }) });
      await navigator.clipboard.writeText(text).catch(() => {});
      CS.toast(`Captcha text: ${text} (copied to clipboard)`, 'ok');
      CS.reportSolved('text', text);
    } catch (e) {
      CS.reportFailed('Image captcha', e.message);
    }
  };

  // Initial scan + watch for captchas added later (SPAs, modals).
  const rescan = CS.debounce(() => scan(), 800);
  const start = () => {
    rescan();
    new MutationObserver(rescan).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
