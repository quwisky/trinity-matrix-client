import type { InstallationResetOutcome } from '@trinity/data-access/accounts';
import type {
  HostPresenceBiometry,
  HostSystemPresenceUnavailableReason,
} from '@trinity/runtime/host';
import { describe, expect, it } from 'vitest';
import {
  fallbackLine,
  resetFailure,
  unlockLabel,
  useMethodLabel,
} from './app-lock-cover.copy';

describe('app lock cover copy', () => {
  it.each<[HostPresenceBiometry, string, string]>([
    ['face', 'Unlock with Face ID', 'Use Face ID'],
    ['touch-id', 'Unlock with Touch ID', 'Use Touch ID'],
    ['fingerprint', 'Unlock with fingerprint', 'Use fingerprint'],
    ['windows-hello', 'Unlock with Windows Hello', 'Use Windows Hello'],
    [
      'passcode-only',
      'Unlock with your device passcode',
      'Use device passcode',
    ],
  ])('labels %s', (biometry, unlock, use) => {
    expect(unlockLabel(biometry)).toBe(unlock);
    expect(useMethodLabel(biometry)).toBe(use);
  });

  it.each<
    [
      HostSystemPresenceUnavailableReason,
      HostPresenceBiometry | null,
      string | null,
    ]
  >([
    ['not-supported', null, null],
    ['windows-version', null, null],
    ['locked-out', 'face', 'Too many tries with Face ID.'],
    ['locked-out', null, 'Too many tries with your device’s unlock.'],
    ['not-configured', 'windows-hello', 'Windows Hello isn’t available.'],
    ['addon-unavailable', null, 'Windows Hello isn’t available.'],
    ['not-enrolled', 'touch-id', 'Touch ID isn’t available.'],
    ['no-device-credential', 'face', 'Face ID isn’t available.'],
    // Never offered on this lock: the PIN is simply how this device unlocks.
    ['not-configured', null, null],
    ['disabled-by-policy', null, null],
    ['no-device-credential', null, null],
    ['not-enrolled', null, null],
    [
      'disabled-by-policy',
      'fingerprint',
      'Fingerprint unlock isn’t available.',
    ],
  ])('explains %s (method %s)', (reason, method, line) => {
    expect(fallbackLine(reason, method)).toBe(line);
  });

  it.each<[InstallationResetOutcome, string | null]>([
    [{ kind: 'ready' }, null],
    [
      { kind: 'transition-in-progress', operation: 'switching-account' },
      'Another account change is still in progress. Try again.',
    ],
    [
      { kind: 'uncertain-cleanup', issues: [], pending: [] },
      'Erasing is still running. Try again to check on it.',
    ],
    [
      {
        kind: 'partial-cleanup',
        issues: [{ scope: 'indexed-db', recovery: 'retry-installation-reset' }],
      },
      'Trinity Next couldn’t erase everything on this device. Try again.',
    ],
    [
      {
        kind: 'partial-cleanup',
        issues: [{ scope: 'secure-storage', recovery: 'restart-application' }],
      },
      'Trinity Next couldn’t erase everything. Restart Trinity Next, then try again.',
    ],
  ])('reports a reset that ended as %o', (outcome, text) => {
    expect(resetFailure(outcome, 'Trinity Next')).toBe(text);
  });
});
