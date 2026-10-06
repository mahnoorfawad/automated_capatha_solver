// Text-question captchas: "What is 7 + 3?", "Seven plus three =", "Type the word 'blue'".
// Arithmetic is solved locally; other questions go to the text model.
(() => {
  const CS = globalThis.CaptchaSolver;
  if (!CS || CS.mathCaptchaLoaded) return;
  CS.mathCaptchaLoaded = true;
  if (/recaptcha|hcaptcha\.com|challenges\.cloudflare\.com/.test(location.href)) return;

  const NUM_WORDS = 'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty';
  const ARITH = new RegExp(
    `(\\d+|${NUM_WORDS})\\s*([+\\-−–x×*\\/÷]|plus|minus|times|multiplied by|divided by|added to)\\s*(\\d+|${NUM_WORDS})`,
    'i'
  );
  const QUESTION_HINT = /captcha|what is|what's|how much|how many|solve|sum of|answer|security question|anti.?spam|are you human|prove|=\s*\?|=\s*$/i;

  /** Text that describes the input: labels, placeholder, and nearby short text. */
  function questionFor(input) {
    const texts = [];
    if (input.labels) texts.push(...[...input.labels].map((l) => l.textContent));
    texts.push(input.placeholder || '', input.getAttribute('aria-label') || '');
    let node = input;
    for (let depth = 0; depth < 3 && node; depth++) {
      node = node.parentElement;
      if (!node) break;
      const t = node.innerText || '';
      if (t.length > 0 && t.length < 160) {
        texts.push(t);
        break;
      }
    }
    for (let sib = input.previousElementSibling, i = 0; sib && i < 2; sib = sib.previousElementSibling, i++) {
      if (sib.innerText && sib.innerText.length < 160) texts.push(sib.innerText);
    }
    const clean = [...new Set(texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))];
    // Drop fragments already contained in a longer piece (label text repeats inside its parent).
    return clean.filter((t) => !clean.some((o) => o !== t && o.includes(t))).join(' | ');
  }

  function findQuestions() {
    const out = [];
    for (const input of document.querySelectorAll('input[type="text"], input[type="number"], input[type="tel"], input:not([type])')) {
      if (!CS.isVisible(input) || input.readOnly || input.disabled) continue;
      if (input.value && input.dataset.csFilled !== '1') continue;
      const q = questionFor(input);
      if (!q) continue;
      const attrs = `${input.name} ${input.id} ${input.className}`;
      const arithmetic = ARITH.test(q) && (QUESTION_HINT.test(q) || /captcha|math|sum|answer|quiz|question/i.test(attrs));
      const captchaQuestion = /captcha|antispam|security.?question|quiz|human/i.test(attrs) && /\?/.test(q);
      if (arithmetic || captchaQuestion) out.push({ input, question: q });
    }
    return out;
  }

  async function solve(input, question) {
    if (input.dataset.csSolvedFor === question) return;
    input.dataset.csSolvedFor = question;
    try {
      const { answer } = await CS.task('question', { question });
      if (!answer) throw new Error('no answer');
      await CS.typeInto(input, answer);
      input.dataset.csFilled = '1';
      CS.toast(`Question captcha answered: ${answer}`, 'ok');
      CS.reportSolved('math', `${question} → ${answer}`);
    } catch (e) {
      delete input.dataset.csSolvedFor;
      CS.reportFailed('Question captcha', e.message);
    }
  }

  async function scan({ manual = false } = {}) {
    if (!manual && !(await CS.autoEnabled('solveMath'))) return;
    for (const { input, question } of findQuestions()) {
      // Image-based captchas are handled by the text solver; skip inputs it already filled.
      if (input.dataset.csFilled === '1' && input.dataset.csSolvedFor !== question) continue;
      if (manual) delete input.dataset.csSolvedFor;
      await solve(input, question);
    }
  }

  CS.manualSolvers.push(() => scan({ manual: true }));
  const rescan = CS.debounce(() => scan(), 900);
  const start = () => {
    rescan();
    new MutationObserver(rescan).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
