import { TestBed } from '@angular/core/testing';
import {
  BiometryErrorType,
  BiometryType,
  type CheckBiometryResult,
} from '@aparajita/capacitor-biometric-auth';
import {
  HOST_OPERATIONS,
  HostCapabilitiesService,
  type HostUserPresenceOperation,
} from '@trinity/runtime/host';
import { desktopBridgeFixture } from '@trinity/testing';
import { firstValueFrom, of } from 'rxjs';
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
  ElectronUserPresenceAdapter,
  WebUserPresenceAdapter,
  parsePresenceOutcome,
  parseUserPresenceSupport,
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

describe('ElectronUserPresenceAdapter', () => {
  afterEach(() => {
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    TestBed.resetTestingModule();
  });

  function adapter(
    granted: boolean,
    userPresence: {
      support: () => Promise<unknown>;
      verify: () => Promise<unknown>;
    },
  ): ElectronUserPresenceAdapter {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture({ capabilities: { userPresence } });
    TestBed.configureTestingModule({
      providers: [
        ElectronUserPresenceAdapter,
        {
          provide: HostCapabilitiesService,
          useValue: {
            manifest: () =>
              of({
                protocolVersion: 1,
                operations: Object.fromEntries(
                  HOST_OPERATIONS.map((operation) => [
                    operation,
                    operation === 'user-presence' && granted
                      ? { kind: 'supported' }
                      : { kind: 'unavailable', reason: 'not-supported' },
                  ]),
                ),
              }),
          },
        },
      ],
    });
    return TestBed.inject(ElectronUserPresenceAdapter);
  }

  it('reads Touch ID support through the granted bridge', async () => {
    const support = vi.fn(() =>
      Promise.resolve({
        system: { kind: 'available', biometry: 'touch-id' },
        pin: { kind: 'unavailable', reason: 'not-supported' },
      }),
    );
    await expect(
      firstValueFrom(adapter(true, { support, verify: vi.fn() }).support()),
    ).resolves.toEqual({
      system: { kind: 'available', biometry: 'touch-id' },
      pin: { kind: 'unavailable', reason: 'not-supported' },
    });
  });

  it('never calls the bridge for an ungranted operation', async () => {
    const support = vi.fn();
    await expect(
      firstValueFrom(adapter(false, { support, verify: vi.fn() }).support()),
    ).resolves.toEqual({
      system: { kind: 'unavailable', reason: 'not-supported' },
      pin: { kind: 'unavailable', reason: 'not-supported' },
    });
    expect(support).not.toHaveBeenCalled();
  });

  it('turns a hostile answer into a stable code', async () => {
    const verify = vi.fn(() =>
      Promise.resolve({ kind: 'verified', token: 'access_token=x' }),
    );
    const outcome = await firstValueFrom(
      adapter(true, { support: vi.fn(), verify }).verify({
        reason: 'Unlock Trinity',
      }),
    );
    expect(outcome).toEqual({ kind: 'verified' });
    expect(JSON.stringify(outcome).includes('access_token')).toBe(false);
  });
});

describe('parsePresenceOutcome and parseUserPresenceSupport', () => {
  it('accept only the declared shapes', () => {
    expect(parsePresenceOutcome({ kind: 'failed' })).toEqual({
      kind: 'failed',
    });
    expect(
      parsePresenceOutcome({ kind: 'unavailable', reason: 'not-configured' }),
    ).toEqual({
      kind: 'unavailable',
      reason: 'not-configured',
    });
    expect(
      parsePresenceOutcome({ kind: 'unavailable', reason: 'hacked' }),
    ).toEqual({
      kind: 'rejected',
      diagnostic: { code: 'electron-malformed-response' },
    });
    expect(parsePresenceOutcome('verified')).toEqual({
      kind: 'rejected',
      diagnostic: { code: 'electron-malformed-response' },
    });
    expect(
      parseUserPresenceSupport({
        system: { kind: 'available', biometry: 'retina' },
        pin: { kind: 'available', set: true, nextAttemptAt: null },
      }),
    ).toEqual({
      system: { kind: 'unavailable', reason: 'not-supported' },
      pin: { kind: 'available', set: true, nextAttemptAt: null },
    });
  });
});
