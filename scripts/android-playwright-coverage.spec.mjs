import { globSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  androidOnly,
  portableLater,
  sharedNow,
  webOnly,
} from '../e2e/android/coverage-manifest.mts';

const workspaceRoot = join(import.meta.dirname, '..');
const webSpecs = globSync('*.spec.mts', {
  cwd: join(workspaceRoot, 'e2e/playwright'),
}).sort();
const androidSpecs = globSync('*.spec.mts', {
  cwd: join(workspaceRoot, 'e2e/android'),
}).sort();
const classified = [
  ...sharedNow.map(({ webSpec }) => webSpec),
  ...portableLater,
  ...webOnly.map(({ webSpec }) => webSpec),
].sort();

describe('Android Playwright coverage manifest', () => {
  it('classifies every web spec exactly once', () => {
    expect(new Set(classified).size).toBe(classified.length);
    expect(classified).toEqual(webSpecs);
  });

  it('points every shared and Android-only journey at a real Android spec', () => {
    const referenced = [
      ...sharedNow.map(({ androidSpec }) => androidSpec),
      ...androidOnly.map(({ androidSpec }) => androidSpec),
    ];
    expect(referenced.every((spec) => androidSpecs.includes(spec))).toBe(true);
  });

  it('records a reason for every intentionally web-only spec', () => {
    expect(webOnly.every(({ reason }) => reason.trim().length > 0)).toBe(true);
  });
});
