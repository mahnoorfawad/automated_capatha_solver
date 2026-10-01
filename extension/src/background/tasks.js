// Captcha-specific prompts and response parsing. Content scripts send images
// and context; these functions turn them into model calls and structured answers.
import { chat } from './llm.js';

/** Extracts the first JSON object/array from a model reply. */
export function parseJson(text) {
  const t = String(text).replace(/```(?:json)?/gi, '');
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = t.indexOf(open);
    const end = t.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        /* try next shape */
      }
    }
  }
  return null;
}

const ARITH = /(-?\d+(?:\.\d+)?)\s*([+\-−–x×*\/÷:])\s*(-?\d+(?:\.\d+)?)/;

/** Evaluates "a op b" if the string contains a simple arithmetic expression. */
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const OP_WORDS = [[/multiplied by|times/gi, '*'], [/divided by/gi, '/'], [/plus|added to/gi, '+'], [/minus/gi, '-']];

export function solveArithmetic(text) {
  let t = String(text).replace(/\s+/g, ' ');
  for (const [re, sym] of OP_WORDS) t = t.replace(re, ` ${sym} `);
  t = t.replace(new RegExp(`\\b(${NUMBER_WORDS.join('|')})\\b`, 'gi'), (w) => String(NUMBER_WORDS.indexOf(w.toLowerCase())));
  const m = t.match(ARITH);
  if (!m) return null;
  const a = parseFloat(m[1]);
  const b = parseFloat(m[3]);
  const op = m[2];
  let r;
  if (op === '+') r = a + b;
  else if ('-−–'.includes(op)) r = a - b;
  else if ('x×*'.includes(op)) r = a * b;
  else if ('/÷:'.includes(op)) r = b === 0 ? null : a / b;
  if (r === null || !Number.isFinite(r)) return null;
  return String(Math.round(r * 1000) / 1000);
}

const isYes = (text) => /^\W*(yes|true|y\b|1\b)/i.test(text.trim());

export async function ocr({ image, digitsOnly, maxLength }, s) {
  const charset = digitsOnly ? 'The answer contains digits only (0-9).' : 'It may contain letters and digits.';
  const len = maxLength ? ` It is at most ${maxLength} characters long.` : '';
  const prompt =
    'This image is a CAPTCHA. Read the distorted characters exactly as shown, left to right. ' +
    `${charset}${len} Ignore background noise, lines and dots. ` +
    'If the image shows an arithmetic question (like "3 + 4 ="), write the expression instead. ' +
    'Reply with ONLY the characters, no spaces, no quotes, no explanation.';
  const raw = await chat({ prompt, images: [image], maxTokens: 40 }, s);

  // Only treat the reply as math when it is purely an expression, so "4x9pk" stays text.
  if (/^\s*\d+\s*[+\-−–x×*\/÷]\s*\d+\s*(=\s*\??)?\s*$/.test(raw)) {
    const math = solveArithmetic(raw);
    if (math !== null) return { text: math, raw, math: true };
  }

  let text = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() || '';
  text = text.replace(/^(the\s+)?(text|captcha|answer|characters?)\s*(is|:)\s*/i, '');
  text = digitsOnly ? text.replace(/\D/g, '') : text.replace(/[^\p{L}\p{N}]/gu, '');
  if (maxLength) text = text.slice(0, maxLength);
  return { text, raw };
}

export async function classifyTile({ image, target, instruction, example, isSquare }, s) {
  let prompt;
  if (example) {
    prompt =
      `CAPTCHA task: "${instruction}". The FIRST image is the example. ` +
      'Does the SECOND image show the same kind of object or match the example as the task requires? ' +
      'Answer only "yes" or "no".';
  } else if (isSquare) {
    prompt =
      `This is one square cut out of a larger photo. CAPTCHA task: "${instruction}". ` +
      `Does this square contain any part of ${target ? `a ${target}` : 'the requested object'} (even a small edge)? ` +
      'Answer only "yes" or "no".';
  } else {
    prompt =
      `CAPTCHA task: "${instruction}". Look at this photo. ` +
      `Does it clearly contain ${target ? `a ${target}` : 'the requested object'}? Answer only "yes" or "no".`;
  }
  const raw = await chat({ prompt, images: example ? [example, image] : [image], maxTokens: 5 }, s);
  return { match: isYes(raw), raw };
}

export async function classifyGrid({ image, rows, cols, target, instruction }, s) {
  const total = rows * cols;
  const prompt =
    `This CAPTCHA image is a ${rows}x${cols} grid. Each cell has a red number label (1-${total}) in its top-left corner, ` +
    'numbered left-to-right, top-to-bottom. ' +
    `Task: "${instruction}". Which cells contain ${target || 'the requested object'}? ` +
    'Respond with JSON only: {"cells": [list of cell numbers]}. Use [] if none.';
  const raw = await chat({ prompt, images: [image], json: true, maxTokens: 80 }, s);
  const parsed = parseJson(raw);
  const list = Array.isArray(parsed) ? parsed : parsed?.cells ?? [];
  const indices = [...new Set(list.map(Number).filter((n) => n >= 1 && n <= total).map((n) => n - 1))];
  return { indices, raw };
}

export async function locate({ image, instruction }, s) {
  const prompt =
    `CAPTCHA task: "${instruction}". The image has a coordinate grid; x and y are percentages (0-100) ` +
    'of the image width and height, measured from the top-left corner. ' +
    'Find every point that must be clicked to complete the task. ' +
    'Respond with JSON only: {"points": [{"x": number, "y": number}]}.';
  const raw = await chat({ prompt, images: [image], json: true, maxTokens: 150 }, s);
  const parsed = parseJson(raw);
  const points = (parsed?.points ?? [])
    .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
    .filter((p) => p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100);
  return { points, raw };
}

export async function question({ question: q }, s) {
  const math = solveArithmetic(q);
  if (math !== null) return { answer: math, local: true };
  const prompt =
    'A website asks this anti-spam question. Answer it as briefly as possible ' +
    '(a single number or word, digits for numbers). Reply with ONLY the answer.\n\n' +
    `Question: ${q}`;
  const raw = await chat({ prompt, maxTokens: 20 }, s);
  return { answer: raw.split('\n')[0].replace(/^["']|["'.]$/g, '').trim(), raw };
}

export async function visual({ image, pageText }, s) {
  const prompt =
    'This is a screenshot of a web page that contains a CAPTCHA. A coordinate grid is drawn on it; ' +
    'x and y are percentages (0-100) of the screenshot width and height from the top-left corner.\n' +
    (pageText ? `Visible instructions on the page: "${pageText.slice(0, 400)}"\n` : '') +
    'Work out how to solve the CAPTCHA. Respond with JSON only, using one of these shapes:\n' +
    '{"type":"click","points":[{"x":..,"y":..}]}  - click these points in order (tiles, matching places, objects)\n' +
    '{"type":"text","text":"..."}  - type this text into the CAPTCHA input\n' +
    '{"type":"drag","from":{"x":..,"y":..},"to":{"x":..,"y":..}}  - drag a slider or puzzle piece\n' +
    '{"type":"none","reason":"..."}  - no CAPTCHA visible';
  const raw = await chat({ prompt, images: [image], json: true, maxTokens: 300 }, s);
  return { action: parseJson(raw) || { type: 'none', reason: 'Unparseable model reply' }, raw };
}
