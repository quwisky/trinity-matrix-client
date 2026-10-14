import { TestBed } from '@angular/core/testing';
import {
  BiometryErrorType,
  BiometryType,
  type CheckBiometryResult,
} from '@aparajita/capacitor-biometric-auth';
import type { HostUserPresenceOperation } from '@trinity/runtime/host';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const plugin = vi.hoisted(() => ({
  checkBiometry: vi.fn(),
  authenticate: vi.fn(),
}));
vi.mock('@aparajita/capacitor-biometric-auth', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@aparajita/capacitor-biometric-auth')
  >()),
  BiometricAuth: plugin,
}));

import {
  CapacitorUserPresenceAdapter,
  WebUserPresenceAdapter,
  presenceOutcomeOfError,
  systemPresenceOf,
} from './host-user-presence.adapters';

function check(over: Partial<CheckBiometryResult>): CheckBiometryResult {
  return {
    isAvailable: true,
    strongBiometryIsAvailable: true,
    biometryType: BiometryType.faceId,
    biometryTypes: [BiometryType.faceId],
    deviceIsSecure: true,
    reason: '',
    code: BiometryErrorType.none,
    ...over,
  };
}

describe('systemPresenceOf', () => {
  it.each([
    [check({}), { kind: 'available', biometry: 'face' }],
    [
      check({ biometryType: BiometryType.touchId }),
      { kind: 'available', biometry: 'touch-id' },
    ],
    [
      check({ biometryType: BiometryType.fingerprintAuthentication }),
      { kind: 'available', biometry: 'fingerprint' },
    ],
    [
      check({
        isAvailable: false,
        biometryType: BiometryType.none,
        code: BiometryErrorType.biometryNotEnrolled,
      }),
      { kind: 'available', biometry: 'passcode-only' },
    ],
    [
      check({ isAvailable: false, deviceIsSecure: false }),
      { kind: 'unavailable', reason: 'no-device-credential' },
    ],
  ] as const)('maps %o', (result, expected) => {
    expect(systemPresenceOf(result)).toEqual(expected);
  });
});

describe('presenceOutcomeOfError', () => {
  it.each([
    [BiometryErrorType.userCancel, { kind: 'cancelled' }],
    [BiometryErrorType.systemCancel, { kind: 'cancelled' }],
    [BiometryErrorType.appCancel, { kind: 'cancelled' }],
    [BiometryErrorType.userFallback, { kind: 'cancelled' }],
    [BiometryErrorType.authenticationFailed, { kind: 'failed' }],
    [BiometryErrorType.biometryLockout, { kind: 'locked-out' }],
    [
      BiometryErrorType.passcodeNotSet,
      { kind: 'unavailable', reason: 'no-device-credential' },
    ],
    [
      BiometryErrorType.noDeviceCredential,
      { kind: 'unavailable', reason: 'no-device-credential' },
    ],
    [
      BiometryErrorType.biometryNotEnrolled,
      { kind: 'unavailable', reason: 'not-enrolled' },
    ],
    [
      BiometryErrorType.biometryNotAvailable,
      { kind: 'unavailable', reason: 'not-supported' },
    ],
    [
      BiometryErrorType.invalidContext,
      { kind: 'rejected', diagnostic: { code: 'presence-failed' } },
    ],
  ] as const)('maps %s', (code, expected) => {
    expect(presenceOutcomeOfError({ code, message: 'os text' })).toEqual(
      expected,
    );
  });

  it('never passes OS text through', () => {
    const outcome = presenceOutcomeOfError(new Error('secret OS detail'));
    expect(outcome).toEqual({
      kind: 'rejected',
      diagnostic: { code: 'presence-failed' },
    });
    expect(JSON.stringify(outcome).includes('secret OS detail')).toBe(false);
  });
});

describe('CapacitorUserPresenceAdapter', () => {
  afterEach(() => {
    vi.clearAllMocks();
    TestBed.resetTestingModule();
  });

  function adapter(): CapacitorUserPresenceAdapter {
    TestBed.configureTestingModule({
      providers: [CapacitorUserPresenceAdapter],
    });
    return TestBed.inject(CapacitorUserPresenceAdapter);
  }

  it('reads support cold, with the PIN still unavailable', async () => {
    plugin.checkBiometry.mockResolvedValue(check({}));
    const support = adapter().support();
    expect(plugin.checkBiometry).not.toHaveBeenCalled();
    await expect(firstValueFrom(support)).resolves.toEqual({
      system: { kind: 'available', biometry: 'face' },
      pin: { kind: 'unavailable', reason: 'not-supported' },
    });
  });

  it('asks with the device passcode allowed and the given reason', async () => {
    plugin.authenticate.mockResolvedValue(undefined);
    await expect(
      firstValueFrom(adapter().verify({ reason: 'Unlock Trinity' })),
    ).resolves.toEqual({ kind: 'verified' });
    expect(plugin.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'Unlock Trinity',
        allowDeviceCredential: true,
        androidConfirmationRequired: false,
      }),
    );
  });

  it('reports a cancelled prompt as cancelled, not failed', async () => {
    plugin.authenticate.mockRejectedValue({
      code: BiometryErrorType.userCancel,
    });
    await expect(
      firstValueFrom(adapter().verify({ reason: 'Unlock Trinity' })),
    ).resolves.toEqual({ kind: 'cancelled' });
  });

  it('treats an unreadable sensor state as no system prompt', async () => {
    plugin.checkBiometry.mockRejectedValue(new Error('bridge down'));
    await expect(firstValueFrom(adapter().support())).resolves.toEqual({
      system: { kind: 'unavailable', reason: 'not-supported' },
      pin: { kind: 'unavailable', reason: 'not-supported' },
    });
  });
});

describe('WebUserPresenceAdapter', () => {
  it('offers neither a system prompt nor a PIN', async () => {
    TestBed.configureTestingModule({ providers: [WebUserPresenceAdapter] });
    const web: HostUserPresenceOperation = TestBed.inject(
      WebUserPresenceAdapter,
    );
    await expect(firstValueFrom(web.support())).resolves.toEqual({
      system: { kind: 'unavailable', reason: 'not-supported' },
      pin: { kind: 'unavailable', reason: 'not-supported' },
    });
    await expect(firstValueFrom(web.verify({ reason: 'x' }))).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    TestBed.resetTestingModule();
  });
});
