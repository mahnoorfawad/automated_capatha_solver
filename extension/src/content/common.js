// Shared helpers for every content script. Loaded first; exposes globalThis.CaptchaSolver.
(() => {
  if (globalThis.CaptchaSolver) return;
  const DEFAULTS = globalThis.CS_DEFAULTS;
  const isTop = window === window.top;

  const CS = (globalThis.CaptchaSolver = {
    isTop,
    handlers: {},
    manualSolvers: [],
  });

  // ---------- settings ----------
  let settingsCache = null;
  CS.getSettings = async () => {
    if (!settingsCache) {
      const { settings = {} } = await chrome.storage.local.get('settings');
      settingsCache = { ...DEFAULTS, ...settings };
    }
    return settingsCache;
  };
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings) settingsCache = null;
  });

  /** True when the given solver should run automatically right now. */
  CS.autoEnabled = async (flag) => {
    const s = await CS.getSettings();
    return s.enabled && s.autoSolve && s[flag];
  };

  // ---------- timing ----------
  CS.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  CS.rand = (a, b) => a + Math.random() * (b - a);
  CS.humanDelay = (base = 400) => CS.sleep(CS.rand(base * 0.6, base * 1.4));

  CS.waitFor = async (fn, timeout = 10000, interval = 200) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        const v = fn();
        if (v) return v;
      } catch {
        /* keep polling */
      }
      await CS.sleep(interval);
    }
    return null;
  };

  CS.debounce = (fn, ms) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  CS.log = async (...args) => {
    if ((await CS.getSettings()).debug) console.log('%c[CaptchaSolver]', 'color:#7c3aed', ...args);
  };

  // ---------- messaging ----------
  CS.send = async (msg) => {
    const res = await chrome.runtime.sendMessage(msg);
    if (!res) throw new Error('No response from extension background');
    if (res.error) throw new Error(res.error);
    return res;
  };
  CS.task = (task, payload) => CS.send({ type: 'task', task, payload });
  CS.toast = (message, level = 'info') => CS.send({ type: 'toast', message, level }).catch(() => {});
  CS.reportSolved = (kind, detail) => CS.send({ type: 'solved', kind, detail }).catch(() => {});
  CS.reportFailed = (kind, error) => {
    CS.toast(`${kind}: ${error}`, 'error');
    return CS.send({ type: 'failed', kind, error: String(error) }).catch(() => {});
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'solve') {
      CS.manualSolvers.forEach((fn) => fn().catch((e) => CS.log('manual solver failed', e)));
      return false;
    }
    const handler = CS.handlers[msg?.type];
    if (!handler) return false;
    Promise.resolve(handler(msg))
      .then((r) => sendResponse(r ?? {}))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  });

  // ---------- DOM ----------
  CS.isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && parseFloat(st.opacity) > 0.05;
  };

  CS.click = (el, { x, y } = {}) => {
    const r = el.getBoundingClientRect();
    const cx = x ?? r.left + r.width * CS.rand(0.35, 0.65);
    const cy = y ?? r.top + r.height * CS.rand(0.35, 0.65);
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerover', base));
    el.dispatchEvent(new MouseEvent('mouseover', base));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    el.focus?.({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', base));
  };

  /** Clicks whatever element is at viewport coordinates (x, y). */
  CS.clickAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return false;
    CS.click(el, { x, y });
    return true;
  };

  /** Drags with mouse + pointer + touch events, in small human-like steps. */
  CS.dragAt = async (from, to) => {
    const el = document.elementFromPoint(from.x, from.y);
    if (!el) return false;
    const fire = (target, type, x, y, buttons) => {
      const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, buttons };
      const P = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      target.dispatchEvent(new P(type, { ...init, pointerType: 'mouse', isPrimary: true }));
    };
    const touch = (target, type, x, y) => {
      try {
        const t = new Touch({ identifier: 1, target, clientX: x, clientY: y });
        target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t] }));
      } catch {
        /* Touch unsupported */
      }
    };
    fire(el, 'pointerdown', from.x, from.y, 1);
    fire(el, 'mousedown', from.x, from.y, 1);
    touch(el, 'touchstart', from.x, from.y);
    const steps = 25;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = 1 - Math.pow(1 - t, 3);
      const x = from.x + (to.x - from.x) * ease;
      const y = from.y + (to.y - from.y) * ease + CS.rand(-1, 1);
      const target = document.elementFromPoint(x, y) || el;
      fire(el, 'pointermove', x, y, 1);
      fire(target === el ? el : document, 'mousemove', x, y, 1);
      touch(el, 'touchmove', x, y);
      await CS.sleep(CS.rand(12, 30));
    }
    fire(el, 'pointerup', to.x, to.y, 0);
    fire(el, 'mouseup', to.x, to.y, 0);
    touch(el, 'touchend', to.x, to.y);
    return true;
  };

  /** Sets an input's value in a way React/Vue/Angular notice. */
  CS.setInputValue = (input, value) => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    input.focus({ preventScroll: true });
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  /** Types text character by character (some captcha widgets listen for keystrokes). */
  CS.typeInto = async (input, text) => {
    CS.setInputValue(input, '');
    let acc = '';
    for (const ch of text) {
      acc += ch;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      CS.setInputValue(input, acc);
      input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      await CS.sleep(CS.rand(40, 110));
    }
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  };

  CS.backgroundImageUrl = (el) => {
    const m = getComputedStyle(el).backgroundImage.match(/url\(["']?(.*?)["']?\)/);
    return m ? new URL(m[1], location.href).href : null;
  };

  // ---------- images ----------
  const loadImage = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image failed to load'));
      img.src = src;
    });

  CS.loadImage = loadImage;

  /**
   * Draws a source (img/canvas/ImageBitmap) region to a PNG data URL, upscaling
   * small images so the vision model sees the characters clearly.
   */
  CS.rasterize = (source, { sx = 0, sy = 0, sw, sh, minSize = 0, maxSize = 1024, bg = '#fff' } = {}) => {
    sw = sw ?? source.naturalWidth ?? source.width;
    sh = sh ?? source.naturalHeight ?? source.height;
    let scale = 1;
    if (minSize && Math.min(sw, sh) < minSize) scale = minSize / Math.min(sw, sh);
    if (Math.max(sw, sh) * scale > maxSize) scale = maxSize / Math.max(sw, sh);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    const ctx = c.getContext('2d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  };

  CS.normalizeDataUrl = async (dataUrl, opts) => CS.rasterize(await loadImage(dataUrl), opts);

  /** Screenshots the visible tab and crops to the element (top frame only). */
  CS.screenshotElement = async (el, opts = {}) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await CS.sleep(250);
    const r = el.getBoundingClientRect();
    const { dataUrl } = await CS.send({ type: 'captureTab' });
    const shot = await loadImage(dataUrl);
    const k = shot.naturalWidth / window.innerWidth;
    return CS.rasterize(shot, { sx: r.left * k, sy: r.top * k, sw: r.width * k, sh: r.height * k, ...opts });
  };

  /** Screenshots an element inside a child iframe, using the top frame to locate the iframe. */
  CS.screenshotInFrame = async (el, opts = {}) => {
    const r = el.getBoundingClientRect();
    const { dataUrl, frame } = await CS.send({ type: 'captureFrame' });
    const shot = await loadImage(dataUrl);
    const k = shot.naturalWidth / frame.viewportWidth;
    const scaleX = frame.width / window.innerWidth || 1;
    const scaleY = frame.height / window.innerHeight || 1;
    return CS.rasterize(shot, {
      sx: (frame.left + r.left * scaleX) * k,
      sy: (frame.top + r.top * scaleY) * k,
      sw: r.width * scaleX * k,
      sh: r.height * scaleY * k,
      ...opts,
    });
  };

  /** Finds the <iframe> in this document that hosts the given URL. */
  CS.findIframe = (url) => {
    const strip = (u) => (u || '').split('#')[0];
    const frames = [...document.querySelectorAll('iframe')];
    return frames.find((f) => f.src === url) || frames.find((f) => strip(f.src) === strip(url) && CS.isVisible(f));
  };

  CS.handlers.iframeRect = ({ url }) => {
    const f = CS.findIframe(url);
    if (!f) return { found: false };
    const r = f.getBoundingClientRect();
    return {
      found: true,
      left: r.left + f.clientLeft,
      top: r.top + f.clientTop,
      width: f.clientWidth,
      height: f.clientHeight,
      viewportWidth: window.innerWidth,
    };
  };

  /**
   * Gets pixels of an <img>, <canvas> or background-image element as a PNG data URL.
   * Order: direct canvas read → tab screenshot (top frame; avoids re-requesting
   * session-bound captcha URLs) → refetch through the background worker.
   */
  CS.elementImage = async (el, opts = {}) => {
    if (el instanceof HTMLCanvasElement) {
      try {
        return CS.rasterize(el, opts);
      } catch {
        /* tainted canvas */
      }
    }
    if (el instanceof HTMLImageElement) {
      if (!el.complete || !el.naturalWidth) await CS.waitFor(() => el.complete && el.naturalWidth, 5000, 100);
      try {
        return CS.rasterize(el, opts);
      } catch {
        /* cross-origin image without CORS */
      }
    }
    if (isTop && CS.isVisible(el)) {
      try {
        return await CS.screenshotElement(el, opts);
      } catch (e) {
        CS.log('screenshot failed', e);
      }
    }
    const url = el instanceof HTMLImageElement ? el.currentSrc || el.src : CS.backgroundImageUrl(el);
    if (!url) {
      if (!isTop) return CS.screenshotInFrame(el, opts);
      throw new Error('Could not read the captcha image');
    }
    const { dataUrl } = await CS.send({ type: 'fetchImage', url });
    return CS.normalizeDataUrl(dataUrl, opts);
  };

  /** Draws a labelled percentage grid over an image (helps models give coordinates). */
  CS.withCoordinateGrid = async (dataUrl, step = 10) => {
    const img = await loadImage(dataUrl);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const fs = Math.max(10, Math.round(Math.min(c.width, c.height) / 45));
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.lineWidth = 1;
    for (let p = step; p < 100; p += step) {
      const x = (c.width * p) / 100;
      const y = (c.height * p) / 100;
      ctx.strokeStyle = 'rgba(255,0,0,0.45)';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, c.height);
      ctx.moveTo(0, y);
      ctx.lineTo(c.width, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(x + 1, 1, fs * 1.6, fs + 2);
      ctx.fillRect(1, y + 1, fs * 1.6, fs + 2);
      ctx.fillStyle = '#d00';
      ctx.fillText(String(p), x + 2, fs);
      ctx.fillText(String(p), 2, y + fs);
    }
    return c.toDataURL('image/png');
  };

  /** Draws numbered labels on each grid cell (for the single-request grid strategy). */
  CS.withCellNumbers = async (dataUrl, rows, cols) => {
    const img = await loadImage(dataUrl);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const cw = c.width / cols;
    const ch = c.height / rows;
    const fs = Math.max(12, Math.round(ch / 5));
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        ctx.strokeRect(col * cw, r * ch, cw, ch);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(col * cw + 2, r * ch + 2, fs * 1.4, fs * 1.2);
        ctx.fillStyle = '#e00';
        ctx.fillText(String(r * cols + col + 1), col * cw + 4, r * ch + fs);
      }
    }
    return c.toDataURL('image/png');
  };

  /** Splits an image into rows×cols tile data URLs. */
  CS.splitImage = async (source, rows, cols, opts = {}) => {
    const img = typeof source === 'string' ? await loadImage(source) : source;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const tiles = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        tiles.push(CS.rasterize(img, { sx: (c * w) / cols, sy: (r * h) / rows, sw: w / cols, sh: h / rows, minSize: 224, ...opts }));
      }
    }
    return tiles;
  };

  /**
   * Classifies a list of tile images and returns indices of matching tiles.
   * Uses the configured strategy (per-tile requests or one numbered-grid request).
   */
  CS.classifyTiles = async ({ tiles, fullImage, rows, cols, target, instruction, example, isSquare }) => {
    const s = await CS.getSettings();
    if (s.gridStrategy === 'grid' && fullImage && rows && cols && !example) {
      const image = await CS.withCellNumbers(fullImage, rows, cols);
      const { indices } = await CS.task('classifyGrid', { image, rows, cols, target, instruction });
      return indices;
    }
    const results = await Promise.all(
      tiles.map((image) =>
        CS.task('classifyTile', { image, target, instruction, example, isSquare })
          .then((r) => r.match)
          .catch(() => false)
      )
    );
    return results.flatMap((m, i) => (m ? [i] : []));
  };

  // ---------- toast UI (top frame only) ----------
  if (isTop) {
    let host;
    CS.handlers.toast = ({ message, level }) => {
      if (!host) {
        host = document.createElement('div');
        host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;pointer-events:none;';
        host.attachShadow({ mode: 'open' }).innerHTML =
          '<style>.t{font:13px/1.4 system-ui,sans-serif;color:#fff;background:#1f2937;border-left:4px solid #7c3aed;' +
          'padding:8px 12px;margin-top:6px;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.25);max-width:340px;' +
          'opacity:0;transform:translateY(6px);transition:all .2s}.t.show{opacity:1;transform:none}' +
          '.error{border-color:#dc2626}.ok{border-color:#16a34a}</style><div id="w"></div>';
        document.documentElement.appendChild(host);
      }
      const t = document.createElement('div');
      t.className = `t ${level}`;
      t.textContent = `🤖 ${message}`;
      host.shadowRoot.getElementById('w').appendChild(t);
      requestAnimationFrame(() => t.classList.add('show'));
      setTimeout(() => {
        t.classList.remove('show');
        setTimeout(() => t.remove(), 250);
      }, level === 'error' ? 7000 : 4000);
    };
  }

  // Generic actions delivered into this frame by the top frame (visual solver).
  CS.handlers.clickAt = ({ x, y }) => ({ ok: CS.clickAt(x, y) });
  CS.handlers.dragAt = async ({ from, to }) => ({ ok: await CS.dragAt(from, to) });
})();
