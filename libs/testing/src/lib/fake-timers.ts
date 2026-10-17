import type { vi } from 'vitest';

type FakeTimersOptions = NonNullable<Parameters<typeof vi.useFakeTimers>[0]>;

/** `vi.useFakeTimers` options that fake the timeout and interval timers only. */
export const TIMERS: FakeTimersOptions = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
};

/** `vi.useFakeTimers` options that fake the timers and `Date`. */
export const TIMERS_AND_DATE: FakeTimersOptions = {
  toFake: [
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'Date',
  ],
};
