import { describe, expect, it } from 'vitest';
import {
  DESKTOP_IMMEDIATE_GRACE_MS,
  awayVerdict,
  lockDelayMs,
} from './away-policy';

describe('lockDelayMs', () => {
  it.each([
    ['immediately', 'mobile', 0],
    ['immediately', 'desktop', DESKTOP_IMMEDIATE_GRACE_MS],
    ['1m', 'mobile', 60_000],
    ['5m', 'desktop', 300_000],
    ['15m', 'mobile', 900_000],
    ['60m', 'desktop', 3_600_000],
  ] as const)('%s on %s is %i ms', (lockAfter, surface, ms) => {
    expect(lockDelayMs(lockAfter, surface)).toBe(ms);
  });
});

describe('awayVerdict', () => {
  const base = {
    awaySince: 1_000_000,
    lockAfter: '1m',
    surface: 'mobile',
  } as const;

  it('waits until the delay has passed', () => {
    expect(awayVerdict({ ...base, now: 1_030_000 })).toEqual({
      kind: 'wait',
      remainingMs: 30_000,
    });
    expect(awayVerdict({ ...base, now: 1_060_000 })).toEqual({ kind: 'lock' });
  });

  it('locks at once on mobile for Immediately', () => {
    expect(
      awayVerdict({ ...base, lockAfter: 'immediately', now: 1_000_000 }),
    ).toEqual({ kind: 'lock' });
  });

  it('gives the desktop ten seconds for Immediately', () => {
    const desktop = {
      ...base,
      lockAfter: 'immediately',
      surface: 'desktop',
    } as const;
    expect(awayVerdict({ ...desktop, now: 1_009_999 })).toEqual({
      kind: 'wait',
      remainingMs: 1,
    });
    expect(awayVerdict({ ...desktop, now: 1_010_000 })).toEqual({
      kind: 'lock',
    });
  });

  it('locks when the clock went backwards while away', () => {
    expect(awayVerdict({ ...base, now: 999_999 })).toEqual({ kind: 'lock' });
  });
});
