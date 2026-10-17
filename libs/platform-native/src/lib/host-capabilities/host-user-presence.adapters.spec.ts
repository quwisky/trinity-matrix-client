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
import {
  AppLockPinBridge,
  type AppLockPinCheck,
  type AppLockPinStatus,
} from '@trinity/capacitor-app-lock';
import { desktopBridgeFixture } from '@trinity/testing';
import { type Observable, firstValueFrom, of, throwError } from 'rxjs';
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
  presenceOutcomeOfError,
  systemPresenceOf,
} from './host-user-presence.adapters';
import {
  parsePinOutcome,
  parsePresenceOutcome,
  parseUserPresenceSupport,
} from './host-user-presence.electron-response';

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
      // iPhone and iPad fall back to the device passcode.
      { kind: 'available', biometry: 'touch-id', fallback: 'passcode' },
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
  const pinBridge = {
    available: true,
    status: vi.fn((): Observable<AppLockPinStatus> =>
      of({ kind: 'ready', set: true, nextAttemptAt: null }),
    ),
    set: vi.fn((): Observable<'completed' | 'invalid' | 'unavailable'> =>
      of('completed'),
    ),
    verify: vi.fn((): Observable<AppLockPinCheck> => of({ kind: 'verified' })),
    clear: vi.fn((): Observable<'completed' | 'unavailable'> =>
      of('completed'),
    ),
  };

  afterEach(() => {
    vi.clearAllMocks();
    pinBridge.available = true;
    TestBed.resetTestingModule();
  });

  function adapter(): CapacitorUserPresenceAdapter {
    TestBed.configureTestingModule({
      providers: [
        CapacitorUserPresenceAdapter,
        { provide: AppLockPinBridge, useValue: pinBridge },
      ],
    });
    return TestBed.inject(CapacitorUserPresenceAdapter);
  }

  it('reads support cold, with the PIN from the plugin', async () => {
    plugin.checkBiometry.mockResolvedValue(check({}));
    const support = adapter().support();
    expect(plugin.checkBiometry).not.toHaveBeenCalled();
    expect(pinBridge.status).not.toHaveBeenCalled();
    await expect(firstValueFrom(support)).resolves.toEqual({
      system: { kind: 'available', biometry: 'face' },
      pin: { kind: 'available', set: true, nextAttemptAt: null },
    });
  });

  it('reports a PIN store it cannot read as secure storage unavailable', async () => {
    plugin.checkBiometry.mockResolvedValue(check({}));
    pinBridge.status.mockReturnValueOnce(of({ kind: 'unavailable' as const }));
    await expect(firstValueFrom(adapter().support())).resolves.toEqual({
      system: { kind: 'available', biometry: 'face' },
      pin: { kind: 'unavailable', reason: 'secure-storage-unavailable' },
    });
  });

  it('reports a failing PIN status call as secure storage unavailable, not "no PIN"', async () => {
    plugin.checkBiometry.mockResolvedValue(check({}));
    pinBridge.status.mockReturnValueOnce(throwError(() => new Error('down')));
    await expect(firstValueFrom(adapter().support())).resolves.toEqual({
      system: { kind: 'available', biometry: 'face' },
      pin: { kind: 'unavailable', reason: 'secure-storage-unavailable' },
    });
  });

  it('reports a host without the plugin as offering no PIN', async () => {
    plugin.checkBiometry.mockResolvedValue(check({}));
    pinBridge.status.mockReturnValueOnce(
      of({ kind: 'not-supported' as const }),
    );
    await expect(firstValueFrom(adapter().support())).resolves.toEqual({
      system: { kind: 'available', biometry: 'face' },
      pin: { kind: 'unavailable', reason: 'not-supported' },
    });
  });

  it('offers the PIN alone on a device without a screen lock', async () => {
    plugin.checkBiometry.mockResolvedValue(
      check({ isAvailable: false, deviceIsSecure: false }),
    );
    await expect(firstValueFrom(adapter().support())).resolves.toEqual({
      system: { kind: 'unavailable', reason: 'no-device-credential' },
      pin: { kind: 'available', set: true, nextAttemptAt: null },
    });
  });

  it('hands the PIN to the plugin for setting and checking', async () => {
    const presence = adapter();
    await firstValueFrom(presence.setPin('482913'));
    expect(pinBridge.set).toHaveBeenCalledTimes(1);
    expect(pinBridge.set).toHaveBeenCalledWith('482913');
    await firstValueFrom(presence.verifyPin('482913'));
    expect(pinBridge.verify).toHaveBeenCalledTimes(1);
    expect(pinBridge.verify).toHaveBeenCalledWith('482913');
  });

  it('sets, verifies and clears the PIN through the plugin', async () => {
    const presence = adapter();
    await expect(firstValueFrom(presence.setPin('482913'))).resolves.toEqual({
      kind: 'completed',
    });
    pinBridge.set.mockReturnValueOnce(of('invalid' as const));
    await expect(firstValueFrom(presence.setPin('12'))).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'pin-invalid' },
    });
    await expect(firstValueFrom(presence.verifyPin('482913'))).resolves.toEqual(
      { kind: 'verified' },
    );
    pinBridge.verify.mockReturnValueOnce(
      of({ kind: 'delayed' as const, nextAttemptAt: 9 }),
    );
    await expect(firstValueFrom(presence.verifyPin('482913'))).resolves.toEqual(
      {
        kind: 'delayed',
        nextAttemptAt: 9,
      },
    );
    await expect(firstValueFrom(presence.clearPin())).resolves.toEqual({
      kind: 'completed',
    });
  });

  it('reports a PIN the plugin could not store as a failure', async () => {
    const presence = adapter();
    pinBridge.set.mockReturnValueOnce(of('unavailable' as const));
    await expect(firstValueFrom(presence.setPin('482913'))).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    pinBridge.set.mockReturnValueOnce(throwError(() => new Error('down')));
    await expect(firstValueFrom(presence.setPin('482913'))).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
  });

  it('never reads a failing PIN check as verified', async () => {
    pinBridge.verify.mockReturnValueOnce(throwError(() => new Error('down')));
    await expect(
      firstValueFrom(adapter().verifyPin('482913')),
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  it('reports a clear the plugin could not confirm as failed, so the reset says so', async () => {
    const presence = adapter();
    pinBridge.clear.mockReturnValueOnce(of('unavailable' as const));
    await expect(firstValueFrom(presence.clearPin())).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'pin-clear-failed' },
    });
    pinBridge.clear.mockReturnValueOnce(throwError(() => new Error('down')));
    await expect(firstValueFrom(presence.clearPin())).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'pin-clear-failed' },
    });
  });

  it('has nothing to clear on a host without the plugin', async () => {
    pinBridge.available = false;
    pinBridge.clear.mockReturnValueOnce(of('unavailable' as const));
    await expect(firstValueFrom(adapter().clearPin())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
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

  it('treats an unreadable sensor state as no system prompt, keeping the PIN', async () => {
    plugin.checkBiometry.mockRejectedValue(new Error('bridge down'));
    await expect(firstValueFrom(adapter().support())).resolves.toEqual({
      system: { kind: 'unavailable', reason: 'not-supported' },
      pin: { kind: 'available', set: true, nextAttemptAt: null },
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
      setPin?: (pin: string) => Promise<unknown>;
      verifyPin?: (pin: string) => Promise<unknown>;
      clearPin?: () => Promise<unknown>;
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
      // A Mac's Touch ID sheet falls back to the account password.
      system: { kind: 'available', biometry: 'touch-id', fallback: 'password' },
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

  it('reads a failing support call as an unreadable PIN store, not "no PIN"', async () => {
    const unreadable = {
      system: { kind: 'unavailable', reason: 'not-supported' },
      pin: { kind: 'unavailable', reason: 'secure-storage-unavailable' },
    };
    const rejecting = vi.fn(() => Promise.reject(new Error('ipc gone')));
    await expect(
      firstValueFrom(
        adapter(true, { support: rejecting, verify: vi.fn() }).support(),
      ),
    ).resolves.toEqual(unreadable);
    TestBed.resetTestingModule();
    const throwing = vi.fn((): Promise<unknown> => {
      throw new Error('preload broke');
    });
    await expect(
      firstValueFrom(
        adapter(true, { support: throwing, verify: vi.fn() }).support(),
      ),
    ).resolves.toEqual(unreadable);
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

  it('forwards PIN commands through the granted bridge and validates the answers', async () => {
    const setPin = vi.fn(() => Promise.resolve({ kind: 'completed' }));
    const verifyPin = vi.fn(() =>
      Promise.resolve({ kind: 'failed', nextAttemptAt: 30_000 }),
    );
    const clearPin = vi.fn(() =>
      Promise.resolve({ kind: 'rejected', diagnostic: { code: 'pin-clear' } }),
    );
    const presence = adapter(true, {
      support: vi.fn(),
      verify: vi.fn(),
      setPin,
      verifyPin,
      clearPin,
    });
    await expect(firstValueFrom(presence.setPin('482913'))).resolves.toEqual({
      kind: 'completed',
    });
    await expect(firstValueFrom(presence.verifyPin('482913'))).resolves.toEqual(
      { kind: 'failed', nextAttemptAt: 30_000 },
    );
    await expect(firstValueFrom(presence.clearPin())).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'pin-clear' },
    });
    expect(setPin).toHaveBeenCalledWith('482913');
    expect(verifyPin).toHaveBeenCalledWith('482913');
    expect(clearPin).toHaveBeenCalledOnce();
  });

  it('never calls the bridge for PIN commands when the operation is not granted', async () => {
    const setPin = vi.fn();
    const verifyPin = vi.fn();
    const clearPin = vi.fn();
    const presence = adapter(false, {
      support: vi.fn(),
      verify: vi.fn(),
      setPin,
      verifyPin,
      clearPin,
    });
    await expect(firstValueFrom(presence.setPin('482913'))).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    await expect(firstValueFrom(presence.verifyPin('482913'))).resolves.toEqual(
      { kind: 'unavailable' },
    );
    await expect(firstValueFrom(presence.clearPin())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-supported',
    });
    expect(setPin).not.toHaveBeenCalled();
    expect(verifyPin).not.toHaveBeenCalled();
    expect(clearPin).not.toHaveBeenCalled();
  });

  it('turns a failing or hostile PIN answer into a stable outcome', async () => {
    const presence = adapter(true, {
      support: vi.fn(),
      verify: vi.fn(),
      setPin: () => Promise.reject(new Error('pin 482913 detail')),
      verifyPin: () => Promise.reject(new Error('pin 482913 detail')),
      clearPin: () =>
        Promise.resolve({
          kind: 'rejected',
          diagnostic: { code: 'Bad Code!' },
        }),
    });
    const outcomes = [
      await firstValueFrom(presence.setPin('482913')),
      await firstValueFrom(presence.verifyPin('482913')),
      await firstValueFrom(presence.clearPin()),
    ];
    expect(outcomes).toEqual([
      { kind: 'unavailable', reason: 'not-supported' },
      { kind: 'unavailable' },
      { kind: 'rejected', diagnostic: { code: 'electron-malformed-response' } },
    ]);
    expect(JSON.stringify(outcomes).includes('482913')).toBe(false);
  });

  it('reports a clear the shell could not confirm, so the full reset sees it', async () => {
    const presence = adapter(true, {
      support: vi.fn(),
      verify: vi.fn(),
      clearPin: () => Promise.reject(new Error('no handler')),
    });
    await expect(firstValueFrom(presence.clearPin())).resolves.toEqual({
      kind: 'rejected',
      diagnostic: { code: 'pin-clear-failed' },
    });
  });
});

describe('parsePinOutcome', () => {
  const malformed = {
    kind: 'rejected',
    diagnostic: { code: 'electron-malformed-response' },
  };
  it.each([
    [{ kind: 'verified' }, { kind: 'verified' }],
    [
      { kind: 'failed', nextAttemptAt: null },
      { kind: 'failed', nextAttemptAt: null },
    ],
    [
      { kind: 'failed', nextAttemptAt: 5 },
      { kind: 'failed', nextAttemptAt: 5 },
    ],
    [
      { kind: 'delayed', nextAttemptAt: 5 },
      { kind: 'delayed', nextAttemptAt: 5 },
    ],
    [{ kind: 'invalid' }, { kind: 'invalid' }],
    [{ kind: 'unavailable' }, { kind: 'unavailable' }],
    [
      { kind: 'rejected', diagnostic: { code: 'sender-rejected' } },
      { kind: 'rejected', diagnostic: { code: 'sender-rejected' } },
    ],
    [{ kind: 'rejected', diagnostic: { code: 'Bad Code!' } }, malformed],
    [{ kind: 'verified', hash: 'abc' }, { kind: 'verified' }],
    [{ kind: 'failed' }, malformed],
    [{ kind: 'failed', nextAttemptAt: Number.NaN }, malformed],
    [{ kind: 'delayed' }, malformed],
    [{ kind: 'delayed', nextAttemptAt: null }, malformed],
    [{ kind: 'delayed', nextAttemptAt: '5' }, malformed],
    ['verified', malformed],
    [null, malformed],
  ] as const)('maps %j', (raw, expected) => {
    expect(parsePinOutcome(raw)).toEqual(expected);
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

describe('parseUserPresenceSupport, the PIN half', () => {
  const unreadable = {
    kind: 'unavailable',
    reason: 'secure-storage-unavailable',
  };

  it('keeps "no PIN store" only for the shell saying so', () => {
    expect(
      parseUserPresenceSupport({
        system: { kind: 'unavailable', reason: 'not-supported' },
        pin: { kind: 'unavailable', reason: 'not-supported' },
      }).pin,
    ).toEqual({ kind: 'unavailable', reason: 'not-supported' });
    expect(
      parseUserPresenceSupport({
        pin: { kind: 'unavailable', reason: 'secure-storage-unavailable' },
      }).pin,
    ).toEqual(unreadable);
  });

  it.each([
    ['no answer at all', undefined],
    ['no PIN half', {}],
    ['a bare string', { pin: 'available' }],
    [
      'a set flag that is not a boolean',
      { pin: { kind: 'available', set: 'yes', nextAttemptAt: null } },
    ],
    [
      'a wait that is not a number',
      { pin: { kind: 'available', set: true, nextAttemptAt: 'soon' } },
    ],
    [
      'a wait that is not finite',
      { pin: { kind: 'available', set: true, nextAttemptAt: Number.NaN } },
    ],
    ['an unknown reason', { pin: { kind: 'unavailable', reason: 'hacked' } }],
    [
      'an unknown kind',
      { pin: { kind: 'ready', set: false, nextAttemptAt: null } },
    ],
  ])(
    'reads a garbled PIN half as unreadable, never "no PIN": %s',
    (_name, raw) => {
      expect(parseUserPresenceSupport(raw).pin).toEqual(unreadable);
    },
  );
});
