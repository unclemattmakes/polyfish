/**
 * DevSplash: the "Uncle Matt Makes: ___" developer splash, the page's
 * loading-into-the-app screen.
 *
 * Ported from Faceted Flight: 10th Anniversary Edition (`src/boot/dev-splash.ts`
 * there), so the two games open the same way. A cream screen with the
 * Uncle Matt Makes lockup; the blank under it TYPES a word a letter at a time,
 * sits, DELETES it, and types the next, each word faster than the one before,
 * landing on "PolyFish" over a load bar. Once the scene is loaded AND PolyFish
 * has been typed and held for SPLASH_HOLD_MS, it fades out to the title.
 *
 *  - A skip (click, tap, Enter, Space, or A on a pad) is honoured only once the
 *    scene is loaded. Before that a press does nothing.
 *  - A load that fails takes the splash down at once so the error is readable.
 *  - The fade is on a timer, not `transitionend`: a hidden tab runs no
 *    transitions, and a splash that waited on one would stand over a loaded
 *    game for ever.
 *
 * The pure schedule (`splashBeats`, `splashFrameAt`, `fadeAt`) is exported for
 * the unit tests; `startDevSplash` drives `#dev-splash` in index.html.
 */

/** The blank's words, unclemattmakes.com's own, the last one the game. */
export const SPLASH_WORDS = [
  'stuff',
  'simulations',
  'automata',
  'critter cams',
  '3d prints',
  'doughnuts',
  'mistakes',
  'games',
  'PolyFish',
];

/** Per letter, the first word, ms. Every next word is quicker (a geometric ramp). */
export const SPLASH_TYPE_SLOW_MS = 45;
/** Per letter, the last word before the game, ms. */
export const SPLASH_TYPE_FAST_MS = 16;
/** How long the first word sits typed before it is deleted, ms. */
export const SPLASH_SIT_SLOW_MS = 220;
/** How long the last word before the game sits, ms. */
export const SPLASH_SIT_FAST_MS = 60;
/** A backspace is quicker than a keystroke: this share of the word's letter time. */
export const SPLASH_DELETE_SHARE = 0.4;
/** The game's name, per letter, ms: quick, but slow enough to read as typed. */
export const SPLASH_FINAL_TYPE_MS = 45;
/** The longest the lockup waits for Bitter and the portrait before it shows, ms. */
export const SPLASH_FACE_WAIT_MS = 600;
/** How long the game's name holds before the fade may start, ms. */
export const SPLASH_HOLD_MS = 2500;
/** The fade out to the game, ms. */
export const SPLASH_FADE_MS = 700;

/** The keyboard keys that skip, by `KeyboardEvent.key`. */
export const SPLASH_SKIP_KEYS = ['Enter', ' '];

/**
 * The Uncle Matt Makes portrait. Served from `assets/brand/` (Vite's publicDir),
 * with Faceted Flight's content bucket as the fallback, so a checkout without
 * the file still shows the mascot.
 */
export const SPLASH_PORTRAIT_PATH = 'brand/uncle-matt-circle.webp';
export const SPLASH_PORTRAIT_FALLBACK_URL =
  'https://ff2-content.mattscott.dev/assets/brand/uncle-matt-circle.webp';

/**
 * Every word's turn on the clock, ms after the typing starts:
 * `{ from, typedAt, deleteFrom, until }`. The last word is never deleted; its
 * `deleteFrom` and `until` are the end of the hold.
 */
export function splashBeats(words = SPLASH_WORDS) {
  const beats = [];
  const ramp = words.length - 1;
  const step = (slow, fast, i) => slow * (fast / slow) ** (i / Math.max(1, ramp - 1));
  let t = 0;
  for (let i = 0; i < ramp; i++) {
    const letters = words[i].length;
    const type = step(SPLASH_TYPE_SLOW_MS, SPLASH_TYPE_FAST_MS, i);
    // The first letter goes in at once; each next one a letter-time later.
    const typedAt = t + (letters - 1) * type;
    const deleteFrom = typedAt + step(SPLASH_SIT_SLOW_MS, SPLASH_SIT_FAST_MS, i);
    const until = deleteFrom + letters * type * SPLASH_DELETE_SHARE;
    beats.push({ from: t, typedAt, deleteFrom, until });
    t = until;
  }
  const typedAt = t + (words[ramp].length - 1) * SPLASH_FINAL_TYPE_MS;
  beats.push({
    from: t,
    typedAt,
    deleteFrom: typedAt + SPLASH_HOLD_MS,
    until: typedAt + SPLASH_HOLD_MS,
  });
  return beats;
}

/** When the game's name is typed in full, ms after the typing starts: the hold begins. */
export const splashLandedMs = (beats) => beats[beats.length - 1].typedAt;

/** The blank at `ms` after the typing starts: `{ index, letters }`. */
export function splashFrameAt(ms, words = SPLASH_WORDS, beats = splashBeats(words)) {
  const last = beats.length - 1;
  let i = 0;
  while (i < last && ms >= beats[i].until) i++;
  const b = beats[i];
  const n = words[i].length;
  const t = Math.max(0, ms - b.from);
  if (ms < b.typedAt) {
    return { index: i, letters: Math.min(n, Math.floor((t / (b.typedAt - b.from)) * (n - 1)) + 1) };
  }
  if (i === last || ms < b.deleteFrom) return { index: i, letters: n };
  const gone = Math.floor(((ms - b.deleteFrom) / (b.until - b.deleteFrom)) * n) + 1;
  return { index: i, letters: Math.max(0, n - gone) };
}

/**
 * When the fade starts, ms after the typing starts, or null while it may not.
 * `loadedAt` is when the scene reported ready; `skippedAt` a press, which is
 * only ever recorded once loaded. Without one: loaded AND the last word landed
 * and held. With one: then.
 */
export function fadeAt(loadedAt, skippedAt, landedMs) {
  if (loadedAt === null) return null;
  if (skippedAt !== null) return Math.max(loadedAt, skippedAt);
  return Math.max(loadedAt, landedMs + SPLASH_HOLD_MS);
}

/** Is the standard mapping's A (button 0) down on any pad? */
function padA() {
  const pads = globalThis.navigator?.getGamepads?.() ?? [];
  for (const pad of pads) if (pad?.buttons[0]?.pressed) return true;
  return false;
}

const NO_SPLASH = {
  progress() {},
  ready() {},
  fail() {},
  covering: () => false,
  lifting: Promise.resolve(),
};

/**
 * Drive `#dev-splash`. Returns:
 *  - `progress(fraction)`: the load, 0..1. The bar eases toward it.
 *  - `ready()`: the scene is in. The fade may start (after the hold, or a skip).
 *  - `fail()`: the load failed. The splash goes now.
 *  - `covering()`: is it on screen, up or fading?
 *  - `lifting`: settles when the fade STARTS, so the scene can come up as it goes.
 */
export function startDevSplash(root, {
  now = () => performance.now(),
  portraitUrl = `${import.meta.env?.BASE_URL ?? '/'}${SPLASH_PORTRAIT_PATH}`,
  words = SPLASH_WORDS,
} = {}) {
  const body = document.body;
  const typed = root?.querySelector('.dev-splash__typed') ?? null;
  const fill = root?.querySelector('.dev-splash__fill') ?? null;
  const bar = root?.querySelector('.dev-splash__bar') ?? null;
  const portrait = root?.querySelector('.dev-splash__portrait') ?? null;
  if (!root || !typed || !fill || !bar) {
    root?.remove();
    body.dataset.splash = 'gone';
    return NO_SPLASH;
  }

  const beats = splashBeats(words);
  const landedMs = splashLandedMs(beats);
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let t0 = now();
  let loadedAt = null;
  let skippedAt = null;
  let phase = 'up';
  let target = 0;
  let drawn = 0;
  let last = t0;
  let frame = 0;
  let release = () => {};
  const lifting = new Promise((resolve) => { release = resolve; });
  body.dataset.splash = phase;

  // The blank, from one frame of the schedule: the word's first `letters`
  // letters, written as text (the caret after it is CSS).
  let drawnKey = '';
  const render = (f) => {
    const key = `${f.index}:${f.letters}`;
    if (key === drawnKey) return;
    drawnKey = key;
    const word = words[f.index];
    typed.textContent = word.slice(0, f.letters);
    typed.dataset.word = String(f.index);
    typed.dataset.letters = String(f.letters);
  };
  const LANDED = { index: words.length - 1, letters: words[words.length - 1].length };
  render(reduced ? LANDED : splashFrameAt(0, words, beats));

  const skip = () => {
    // Only once the scene is in. Before that a press does nothing.
    if (phase !== 'up' || loadedAt === null || skippedAt !== null) return;
    skippedAt = now() - t0;
    render(LANDED);
  };
  // Capture phase, never consumed: the audio unlock rides the same gesture.
  const onKey = (e) => { if (SPLASH_SKIP_KEYS.includes(e.key)) skip(); };
  const onPointer = () => skip();
  globalThis.addEventListener('keydown', onKey, true);
  globalThis.addEventListener('pointerdown', onPointer, true);

  const finish = () => {
    globalThis.removeEventListener('keydown', onKey, true);
    globalThis.removeEventListener('pointerdown', onPointer, true);
    cancelAnimationFrame(frame);
    phase = 'gone';
    body.dataset.splash = phase;
    root.remove();
    release();
  };
  const startFade = () => {
    if (phase !== 'up') return;
    phase = 'fading';
    body.dataset.splash = phase;
    root.style.transition = `opacity ${SPLASH_FADE_MS}ms ease`;
    root.style.opacity = '0';
    root.style.pointerEvents = 'none';
    setTimeout(finish, SPLASH_FADE_MS);
    release();
  };

  // The typing's clock starts when the lockup can show in Bitter with its
  // portrait (or when it stops waiting), so nothing changes face or pops in
  // mid-word.
  let faced = false;
  const showFace = () => {
    if (faced || phase === 'gone') return;
    faced = true;
    t0 = now();
    last = t0;
    root.classList.add('is-faced');
  };
  const faceReady = document.fonts
    ? document.fonts.load('700 1em Bitter').then(() => {}, () => {})
    : Promise.resolve();
  const portraitReady = new Promise((resolve) => {
    if (!portrait) return resolve();
    let triedFallback = false;
    portrait.addEventListener('load', () => {
      portrait.classList.add('is-loaded');
      resolve();
    });
    portrait.addEventListener('error', () => {
      if (!triedFallback) {
        triedFallback = true;
        portrait.src = SPLASH_PORTRAIT_FALLBACK_URL;
        return;
      }
      // A portrait that cannot load leaves the wordmark on its own, never a
      // broken-image box.
      portrait.remove();
      resolve();
    });
    portrait.src = portraitUrl;
  });
  Promise.all([faceReady, portraitReady]).then(showFace);
  setTimeout(showFace, SPLASH_FACE_WAIT_MS);

  let padWasDown = padA();
  const tick = () => {
    const t = now();
    const ms = t - t0;
    if (phase === 'up' && faced) {
      if (!reduced && skippedAt === null) render(splashFrameAt(ms, words, beats));
      // A pad gives a page no event: read A here, on its press edge.
      const pad = padA();
      if (pad && !padWasDown) skip();
      padWasDown = pad;
      const at = fadeAt(loadedAt, skippedAt, landedMs);
      if (at !== null && ms >= at) startFade();
    }
    // The bar eases toward the load rather than jumping chunk to chunk.
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    drawn += (target - drawn) * (1 - Math.exp(-dt * 8));
    if (target - drawn < 0.002) drawn = target;
    fill.style.transform = `scaleX(${drawn.toFixed(4)})`;
    bar.setAttribute('aria-valuenow', String(Math.round(drawn * 100)));
    if (phase !== 'gone') frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return {
    progress(fraction) {
      if (phase === 'gone') return;
      target = Math.max(target, Math.min(1, Math.max(0, fraction)));
    },
    ready() {
      if (phase === 'gone' || loadedAt !== null) return;
      target = 1;
      loadedAt = now() - t0;
      if (faced && loadedAt >= fadeAt(loadedAt, null, landedMs)) startFade();
    },
    fail() {
      if (phase !== 'gone') finish();
    },
    covering: () => phase !== 'gone',
    lifting,
  };
}
