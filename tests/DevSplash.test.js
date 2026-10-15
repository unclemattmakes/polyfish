import { describe, it, expect } from 'vitest';
import {
  SPLASH_WORDS,
  SPLASH_HOLD_MS,
  splashBeats,
  splashLandedMs,
  splashFrameAt,
  fadeAt,
} from '../src/rendering/DevSplash.js';

describe('DevSplash', () => {
  const beats = splashBeats(SPLASH_WORDS);
  const landed = splashLandedMs(beats);

  it('lands on PolyFish', () => {
    expect(SPLASH_WORDS.at(-1)).toBe('PolyFish');
    expect(splashFrameAt(landed, SPLASH_WORDS, beats)).toEqual({
      index: SPLASH_WORDS.length - 1,
      letters: 'PolyFish'.length,
    });
  });

  it('starts by typing the first letter of the first word', () => {
    expect(splashFrameAt(0, SPLASH_WORDS, beats)).toEqual({ index: 0, letters: 1 });
  });

  it('runs the beats back to back, each word quicker than the one before', () => {
    for (let i = 1; i < beats.length; i++) expect(beats[i].from).toBe(beats[i - 1].until);
    const perLetter = (i) => (beats[i].typedAt - beats[i].from) / (SPLASH_WORDS[i].length - 1);
    for (let i = 1; i < beats.length - 1; i++) expect(perLetter(i)).toBeLessThan(perLetter(i - 1));
  });

  it('deletes a word to nothing before the next is typed', () => {
    const b = beats[0];
    expect(splashFrameAt(b.until - 0.001, SPLASH_WORDS, beats)).toEqual({ index: 0, letters: 0 });
    expect(splashFrameAt(b.until, SPLASH_WORDS, beats).index).toBe(1);
  });

  it('never deletes the last word', () => {
    const frame = splashFrameAt(landed + SPLASH_HOLD_MS * 10, SPLASH_WORDS, beats);
    expect(frame.letters).toBe('PolyFish'.length);
  });

  it('waits for the load, then the hold, unless skipped', () => {
    expect(fadeAt(null, null, landed)).toBeNull();
    expect(fadeAt(100, null, landed)).toBe(landed + SPLASH_HOLD_MS);
    expect(fadeAt(landed + SPLASH_HOLD_MS + 500, null, landed)).toBe(landed + SPLASH_HOLD_MS + 500);
    expect(fadeAt(100, 300, landed)).toBe(300);
  });
});
