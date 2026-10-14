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
    expect(ok.promptTouchID).toHaveBeenCalledWith('Unlock Trinity');
    const no = prefs(true, () => Promise.reject(new Error('cancelled')));
    await expect(
      touchIdDriver(no).verify('Unlock Trinity', null),
    ).resolves.toEqual({ kind: 'cancelled' });
  });

  it('does not prompt once Touch ID became unavailable', async () => {
    const gone = prefs(false, () => Promise.resolve());
    await expect(
      touchIdDriver(gone).verify('Unlock Trinity', null),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'not-supported' });
    expect(gone.promptTouchID).not.toHaveBeenCalled();
  });
});

describe('systemPresenceDriver', () => {
  it.each(['linux', 'win32'] as const)(
    'has no system prompt on %s yet',
    (platform) => {
      expect(
        systemPresenceDriver(platform, {
          systemPreferences: prefs(true, () => Promise.resolve()),
        }),
      ).toBe(NO_SYSTEM_PRESENCE);
    },
  );
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
});
