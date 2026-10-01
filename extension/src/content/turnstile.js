// Cloudflare Turnstile: usually passes on its own; when it shows "Verify you are human",
// click the checkbox (which lives inside a closed shadow root).
(() => {
  const CS = globalThis.CaptchaSolver;
  if (!CS || CS.turnstileLoaded || location.hostname !== 'challenges.cloudflare.com') return;
  CS.turnstileLoaded = true;

  /** querySelector that also descends into open and closed shadow roots. */
  function deepQuery(root, selector) {
    const hit = root.querySelector(selector);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) {
      const shadow = chrome.dom?.openOrClosedShadowRoot?.(el) || el.shadowRoot;
      if (shadow) {
        const found = deepQuery(shadow, selector);
        if (found) return found;
      }
    }
    return null;
  }

  let clicked = 0;
  let cooldownUntil = 0;
  async function tryClick(manual) {
    if (!manual && !(await CS.autoEnabled('solveTurnstile'))) return;
    if (!manual && (clicked >= 3 || Date.now() < cooldownUntil)) return;
    const box = deepQuery(document, 'input[type="checkbox"]') || deepQuery(document, '.ctp-checkbox-label, label.cb-lb');
    if (!box || !CS.isVisible(box)) return;
    clicked++;
    cooldownUntil = Date.now() + 10000;
    await CS.humanDelay(1200);
    CS.click(box.closest('label') || box);
    CS.toast('Turnstile: clicked "Verify you are human"');
  }

  CS.manualSolvers.push(() => tryClick(true));
  let tries = 0;
  const timer = setInterval(() => {
    tryClick(false);
    if (++tries > 30) clearInterval(timer);
  }, 1000);
})();
