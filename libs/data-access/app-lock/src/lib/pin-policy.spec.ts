import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatRetryWait, isValidPin, waitSecondsAfter } from './pin-policy';

const cases = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      '../../../../../native/app-lock/pin-policy-cases.json',
    ),
    'utf8',
  ),
) as {
  formats: { name: string; pin: string; valid: boolean }[];
  delays: { failures: number; waitSeconds: number }[];
};

describe('PIN policy in the renderer', () => {
  it.each(cases.formats)(
    'refuses what the hosts refuse: $name',
    ({ pin, valid }) => {
      expect(isValidPin(pin)).toBe(valid);
    },
  );

  it.each(cases.delays)(
    'waits like the hosts after $failures failures',
    ({ failures, waitSeconds }) => {
      expect(waitSecondsAfter(failures)).toBe(waitSeconds);
    },
  );

  it.each([
    [1_000, '1 second'],
    [29_100, '30 seconds'],
    [60_000, '1 minute'],
    [61_000, '2 minutes'],
    [5 * 60_000, '5 minutes'],
    [60 * 60_000, '1 hour'],
    [59 * 60_000 + 1, '1 hour'],
    [60 * 60_000 + 1, '2 hours'],
    [2 * 60 * 60_000, '2 hours'],
    [25 * 60 * 60_000 - 1, '25 hours'],
  ])('says %i ms as %s', (ms, text) => {
    expect(formatRetryWait(ms)).toBe(text);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'says an unknown wait (%s) as the longest single wait',
    (ms) => {
      expect(formatRetryWait(ms)).toBe('1 hour');
    },
  );
});
