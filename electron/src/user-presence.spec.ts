import { describe, expect, it, vi } from 'vitest';
import {
  NO_SYSTEM_PRESENCE,
  presenceReason,
  systemPresenceDriver,
  touchIdDriver,
} from './user-presence';

function prefs(canPrompt: boolean, prompt: () => Promise<void>) {
  return {
    canPromptTouchID: vi.fn(() => canPrompt),
    promptTouchID: vi.fn(prompt),
  };
}

describe('touchIdDriver', () => {
  it('offers Touch ID only where macOS can prompt for it', async () => {
    await expect(
      touchIdDriver(prefs(true, () => Promise.resolve())).support(),
    ).resolves.toEqual({ kind: 'available', biometry: 'touch-id' });
    await expect(
      touchIdDriver(prefs(false, () => Promise.resolve())).support(),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'not-supported' });
  });

  it('verifies with the reason, and treats any rejection as cancelled', async () => {
    const ok = prefs(true, () => Promise.resolve());
    await expect(
      touchIdDriver(ok).verify('Unlock Trinity', null),
    ).resolves.toEqual({ kind: 'verified' });
    expect(ok.promptTouchID).toHaveBeenCalledWith('unlock Trinity');
    const no = prefs(true, () => Promise.reject(new Error('cancelled')));
    await expect(
      touchIdDriver(no).verify('Unlock Trinity', null),
    ).resolves.toEqual({ kind: 'cancelled' });
  });

  // macOS shows "<App> is trying to <reason>", so the reason continues that sentence.
  it.each([
    ['Unlock Trinity Next', 'unlock Trinity Next'],
    ['Turn on app lock', 'turn on app lock'],
    ['Change app lock settings', 'change app lock settings'],
    ['already lower case', 'already lower case'],
  ])(
    'lower-cases the first letter of %j for the macOS sentence',
    async (reason, shown) => {
      const ok = prefs(true, () => Promise.resolve());
      await touchIdDriver(ok).verify(reason, null);
      expect(ok.promptTouchID).toHaveBeenCalledWith(shown);
    },
  );

  it('does not prompt once Touch ID became unavailable', async () => {
    const gone = prefs(false, () => Promise.resolve());
    await expect(
      touchIdDriver(gone).verify('Unlock Trinity', null),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'not-supported' });
    expect(gone.promptTouchID).not.toHaveBeenCalled();
  });
});

describe('systemPresenceDriver', () => {
  it('has no system prompt on linux', () => {
    expect(
      systemPresenceDriver('linux', {
        systemPreferences: prefs(true, () => Promise.resolve()),
      }),
    ).toBe(NO_SYSTEM_PRESENCE);
  });

  it('offers Windows Hello on Windows 11 through the addon', async () => {
    const windowsHello = {
      availability: vi.fn(async () => 'available'),
      verify: vi.fn(async () => 'verified'),
    };
    await expect(
      systemPresenceDriver('win32', {
        systemPreferences: prefs(true, () => Promise.resolve()),
        windowsHello,
        windowsBuild: 22631,
      }).support(),
    ).resolves.toEqual({ kind: 'available', biometry: 'windows-hello' });
  });

  it('leaves Windows on the PIN without the addon', async () => {
    await expect(
      systemPresenceDriver('win32', {
        systemPreferences: prefs(true, () => Promise.resolve()),
      }).support(),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'addon-unavailable' });
  });
});

describe('presenceReason', () => {
  it.each([
    ['Unlock Trinity', 'Unlock Trinity'],
    ['  Turn on app lock  ', 'Turn on app lock'],
    ['', null],
    ['   ', null],
    ['x'.repeat(121), null],
    [42, null],
    [undefined, null],
  ] as const)('accepts %j as %j', (raw, expected) => {
    expect(presenceReason(raw)).toBe(expected);
  });

  it.each([
    ['a right-to-left override', 'Unlock\u202eTrinity', 'UnlockTrinity'],
    ['isolates', '\u2066Unlock Trinity\u2069', 'Unlock Trinity'],
    ['direction marks', '\u200eUnlock\u200f Trinity', 'Unlock Trinity'],
    ['embeddings', 'Unlock\u202a\u202b\u202c\u202d Trinity', 'Unlock Trinity'],
    ['more isolates', '\u2067\u2068Unlock Trinity', 'Unlock Trinity'],
    ['a newline and a bell', 'Unlock\nTrinity\u0007', 'UnlockTrinity'],
    ['NUL and DEL', '\u0000 Unlock Trinity \u007f', 'Unlock Trinity'],
    ['C1 controls', 'Unlock\u0085\u009f Trinity', 'Unlock Trinity'],
    ['nothing but marks', '\u202e\u0000\u2066', null],
    ['a mark past the cap', `${'x'.repeat(120)}\u202e`, 'x'.repeat(120)],
  ] as const)('strips %s before trimming', (_label, raw, expected) => {
    expect(presenceReason(raw)).toBe(expected);
  });
});
