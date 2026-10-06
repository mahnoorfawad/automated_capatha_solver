// Generic "visual" solver (top frame, on demand): screenshot the tab, let the vision
// model decide what to click / type / drag, then perform it — including inside iframes.
// Covers custom puzzles: "click the matching places", "click in order", sliders, odd text captchas.
(() => {
  const CS = globalThis.CaptchaSolver;
  if (!CS || !CS.isTop || CS.visualLoaded) return;
  CS.visualLoaded = true;

  const INSTRUCTION = /captcha|select|click|tap|drag|slide|match|type the|enter the|verify|robot|human|puzzle|in order|rotate/i;

  function instructionsText() {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && out.length < 6; n = walker.nextNode()) {
      const t = n.textContent.replace(/\s+/g, ' ').trim();
      if (t.length > 6 && t.length < 160 && INSTRUCTION.test(t) && CS.isVisible(n.parentElement)) out.push(t);
    }
    return out.join(' | ');
  }

  /** Delivers a click/drag at viewport coordinates, routing into an iframe when needed. */
  async function actAt(kind, point, to) {
    const el = document.elementFromPoint(point.x, point.y);
    if (el instanceof HTMLIFrameElement) {
      const r = el.getBoundingClientRect();
      const local = (p) => ({ x: p.x - r.left - el.clientLeft, y: p.y - r.top - el.clientTop });
      const action = kind === 'click' ? { type: 'clickAt', ...local(point) } : { type: 'dragAt', from: local(point), to: local(to) };
      return CS.send({ type: 'frameAction', frameUrl: el.src, action });
    }
    return kind === 'click' ? CS.clickAt(point.x, point.y) : CS.dragAt(point, to);
  }

  function captchaInput() {
    const inputs = [...document.querySelectorAll('input[type="text"], input:not([type]), input[type="number"], input[type="tel"]')].filter(
      (i) => CS.isVisible(i) && !i.readOnly && !i.disabled
    );
    return (
      inputs.find((i) => /captcha|code|verif|answer/i.test(`${i.name} ${i.id} ${i.placeholder} ${i.className}`)) ||
      (document.activeElement?.matches?.('input, textarea') ? document.activeElement : null) ||
      inputs.find((i) => !i.value)
    );
  }

  CS.handlers.visualSolve = async () => {
    try {
      CS.toast('Visual solve: taking screenshot…');
      const { dataUrl } = await CS.send({ type: 'captureTab' });
      const shot = await CS.loadImage(dataUrl);
      const scaled = CS.rasterize(shot, { maxSize: 1400 });
      const image = await CS.withCoordinateGrid(scaled);
      CS.toast('Visual solve: asking the model…');
      const { action } = await CS.task('visual', { image, pageText: instructionsText() });
      await CS.log('visual action', action);

      const toViewport = (p) => ({ x: (Number(p.x) / 100) * window.innerWidth, y: (Number(p.y) / 100) * window.innerHeight });
      switch (action.type) {
        case 'click': {
          const points = (action.points || []).map(toViewport);
          if (!points.length) throw new Error('model returned no points');
          for (const p of points) {
            await actAt('click', p);
            await CS.humanDelay(450);
          }
          CS.toast(`Visual solve: clicked ${points.length} point(s)`, 'ok');
          break;
        }
        case 'text': {
          const input = captchaInput();
          if (!input || !action.text) throw new Error('no input or text to type');
          await CS.typeInto(input, String(action.text));
          CS.toast(`Visual solve: typed "${action.text}"`, 'ok');
          break;
        }
        case 'drag': {
          if (!action.from || !action.to) throw new Error('model returned an incomplete drag');
          await actAt('drag', toViewport(action.from), toViewport(action.to));
          CS.toast('Visual solve: dragged', 'ok');
          break;
        }
        default:
          CS.toast(`Visual solve: nothing to do (${action.reason || 'no captcha found'})`);
          return {};
      }
      CS.reportSolved('visual', action.type);
    } catch (e) {
      CS.reportFailed('Visual solve', e.message);
    }
    return {};
  };
})();
