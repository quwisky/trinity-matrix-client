import { TestBed } from '@angular/core/testing';
import {
  HOST_AUTHENTICATION_HANDOFF_OPERATION,
  HOST_USER_PRESENCE_OPERATION,
  HostSystemUiService,
  type HostAuthenticationHandoffOperation,
  type HostOperationOutcome,
  type HostPinOutcome,
  type HostPresenceOutcome,
  type HostUserPresenceOperation,
  type HostUserPresenceSupport,
} from '@trinity/runtime/host';
import {
  PREFERENCE_STORAGE_ADAPTER,
  type PreferenceStorageAdapter,
} from '@trinity/runtime/preferences';
import {
  NEVER,
  Subject,
  firstValueFrom,
  of,
  throwError,
  type Observable,
} from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_LOCK_CLOCK } from './app-lock.tokens';
import { GUARD_WINDOW_MS, PRESENCE_REASONS } from './app-lock.models';
import { AppLockService } from './app-lock.service';

const START = 1_000_000;

const FACE_AND_PIN: HostUserPresenceSupport = {
  system: { kind: 'available', biometry: 'face' },
  pin: { kind: 'available', set: true, nextAttemptAt: null },
};

const PIN_ONLY: HostUserPresenceSupport = {
  system: { kind: 'unavailable', reason: 'not-supported' },
  pin: { kind: 'available', set: true, nextAttemptAt: null },
};

interface Setup {
  readonly stored?: Record<string, unknown> | 'unavailable';
  readonly support?: HostUserPresenceSupport | 'never';
  readonly verify?: () => Observable<HostPresenceOutcome>;
  readonly verifyPin?: () => Observable<HostPinOutcome>;
  readonly setPin?: () => Observable<HostOperationOutcome>;
  readonly clearPin?: () => Observable<HostOperationOutcome>;
  readonly writeFails?: boolean;
  /** The host's app name; `throws` is a desktop shell that reported no identity. */
  readonly appName?: string | 'throws';
}

function setup(options: Setup = {}) {
  let now = START;
  const writes: { key: string; payload: string }[] = [];
  const stored = options.stored ?? { 'trinity.app-lock.enabled': true };
  const storage: PreferenceStorageAdapter = {
    read: ({ key }) =>
      of(
        stored === 'unavailable'
          ? { kind: 'unavailable', diagnostic: { code: 'io' } }
          : key in stored
            ? {
                kind: 'found',
                payload: JSON.stringify({ version: 1, value: stored[key] }),
              }
            : { kind: 'missing' },
      ),
    write: (request) => {
      if (options.writeFails) {
        return of({ kind: 'unavailable', diagnostic: { code: 'io' } });
      }
      writes.push({ key: request.key, payload: request.payload });
      return of({ kind: 'completed' });
    },
  };
  const adapter: HostUserPresenceOperation = {
    support: vi.fn(() =>
      options.support === 'never' ? NEVER : of(options.support ?? FACE_AND_PIN),
    ),
    verify: vi.fn(
      options.verify ?? (() => of<HostPresenceOutcome>({ kind: 'verified' })),
    ),
    setPin: vi.fn(
      options.setPin ?? (() => of<HostOperationOutcome>({ kind: 'completed' })),
    ),
    verifyPin: vi.fn(
      options.verifyPin ?? (() => of<HostPinOutcome>({ kind: 'verified' })),
    ),
    clearPin: vi.fn(
      options.clearPin ??
        (() => of<HostOperationOutcome>({ kind: 'completed' })),
    ),
  };
  const handoff: HostAuthenticationHandoffOperation | null =
    options.appName === undefined
      ? null
      : {
          callback: (request) => ({
            url: request.webUrl,
            applicationType: 'web',
          }),
          open: () => of({ kind: 'completed' }),
          deviceDisplayName: () => {
            if (options.appName === 'throws') {
              throw new Error(
                'The desktop shell did not report its app identity.',
              );
            }
            return options.appName ?? 'Trinity';
          },
        };
  TestBed.configureTestingModule({
    providers: [
      { provide: PREFERENCE_STORAGE_ADAPTER, useValue: storage },
      { provide: HOST_USER_PRESENCE_OPERATION, useValue: adapter },
      { provide: APP_LOCK_CLOCK, useValue: () => now },
      ...(handoff
        ? [
            {
              provide: HOST_AUTHENTICATION_HANDOFF_OPERATION,
              useValue: handoff,
            },
          ]
        : []),
    ],
  });
  return {
    lock: TestBed.inject(AppLockService),
    adapter,
    writes,
    advance: (ms: number) => (now += ms),
  };
}

const hydrated = async (lock: AppLockService) =>
  firstValueFrom(lock.hydrate(), { defaultValue: undefined });

describe('AppLockService', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  describe('hydrate', () => {
    it('starts locked when the lock is on, and off by default', async () => {
      const on = setup();
      await hydrated(on.lock);
      expect(on.lock.status()).toBe('locked');
      TestBed.resetTestingModule();
      const off = setup({ stored: {} });
      await hydrated(off.lock);
      expect(off.lock.status()).toBe('off');
    });

    it('lets a readable off win over a leftover PIN', async () => {
      const { lock } = setup({ stored: { 'trinity.app-lock.enabled': false } });
      await hydrated(lock);
      expect(lock.status()).toBe('off');
    });

    it('trusts the stored PIN when the setting cannot be read', async () => {
      const { lock } = setup({ stored: 'unavailable' });
      await hydrated(lock);
      expect(lock.status()).toBe('locked');
      expect(lock.enabled()).toBe(true);
    });

    it('stays locked when the setting cannot be read, even with no PIN set', async () => {
      const { lock } = setup({
        stored: 'unavailable',
        support: {
          ...FACE_AND_PIN,
          pin: { kind: 'available', set: false, nextAttemptAt: null },
        },
      });
      await hydrated(lock);
      expect(lock.status()).toBe('locked');
      // Refreshing support never turns an unreadable setting into "off".
      await firstValueFrom(lock.refreshSupport());
      expect(lock.status()).toBe('locked');
    });

    it('fails closed when neither the setting nor the host answers', async () => {
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
        ],
      });
      try {
        const { lock } = setup({ stored: 'unavailable', support: 'never' });
        const done = firstValueFrom(lock.hydrate(), {
          defaultValue: undefined,
        });
        await vi.advanceTimersByTimeAsync(3_000);
        await done;
        expect(lock.status()).toBe('locked');
        expect(lock.resetOnly()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stays locked with only the reset left when the PIN record is unreadable and there is no system prompt', async () => {
      const { lock, adapter } = setup({
        support: {
          system: { kind: 'unavailable', reason: 'not-supported' },
          pin: { kind: 'unavailable', reason: 'secure-storage-unavailable' },
        },
        verifyPin: () => of<HostPinOutcome>({ kind: 'unavailable' }),
      });
      await hydrated(lock);
      expect(lock.status()).toBe('locked');
      expect(lock.pinState()).toBe('unavailable');
      expect(lock.resetOnly()).toBe(true);
      await expect(
        firstValueFrom(lock.unlockWithPin('482913')),
      ).resolves.toEqual({
        kind: 'unavailable',
      });
      await expect(firstValueFrom(lock.unlockWithSystem())).resolves.toEqual({
        kind: 'use-pin',
        reason: 'not-supported',
      });
      expect(adapter.verify).not.toHaveBeenCalled();
      expect(lock.status()).toBe('locked');
    });

    it('keeps the system prompt as the way in when only the PIN record is unreadable', async () => {
      const { lock } = setup({
        support: {
          system: { kind: 'available', biometry: 'touch-id' },
          pin: { kind: 'unavailable', reason: 'secure-storage-unavailable' },
        },
      });
      await hydrated(lock);
      expect(lock.resetOnly()).toBe(false);
      await expect(firstValueFrom(lock.unlockWithSystem())).resolves.toEqual({
        kind: 'unlocked',
      });
    });

    it('neither dead-ends nor unlocks when the lock is on but no PIN is stored', async () => {
      // A reset cleared the PIN, then failed to wipe the preferences.
      const { lock } = setup({
        support: {
          system: { kind: 'unavailable', reason: 'not-supported' },
          pin: { kind: 'available', set: false, nextAttemptAt: null },
        },
      });
      await hydrated(lock);
      expect(lock.status()).toBe('locked');
      expect(lock.pinState()).toBe('not-set');
      expect(lock.resetOnly()).toBe(true);
      await firstValueFrom(lock.refreshSupport());
      expect(lock.status()).toBe('locked');
    });

    it('drops a PIN wait the host reports as already over', async () => {
      const { lock } = setup({
        support: {
          ...FACE_AND_PIN,
          pin: { kind: 'available', set: true, nextAttemptAt: START - 5_000 },
        },
      });
      await hydrated(lock);
      expect(lock.support().pin).toEqual({
        kind: 'available',
        set: true,
        nextAttemptAt: null,
      });
    });
  });

  describe('unlocking', () => {
    it('unlocks with the system prompt and releases waiting work', async () => {
      const { lock } = setup();
      await hydrated(lock);
      const released = vi.fn();
      lock.whenUnlocked().subscribe(released);
      expect(released).not.toHaveBeenCalled();
      await expect(firstValueFrom(lock.unlockWithSystem())).resolves.toEqual({
        kind: 'unlocked',
      });
      expect(lock.status()).toBe('unlocked');
      expect(released).toHaveBeenCalledOnce();
    });

    it('names the running app in the unlock prompt', async () => {
      const next = setup({ appName: 'Trinity Next' });
      await hydrated(next.lock);
      await firstValueFrom(next.lock.unlockWithSystem());
      expect(next.adapter.verify).toHaveBeenCalledWith({
        reason: 'Unlock Trinity Next',
      });
      expect(next.lock.appName).toBe('Trinity Next');
    });

    it('falls back to Trinity when the host reports no app name', async () => {
      const broken = setup({ appName: 'throws' });
      await hydrated(broken.lock);
      await firstValueFrom(broken.lock.unlockWithSystem());
      expect(broken.adapter.verify).toHaveBeenCalledWith({
        reason: 'Unlock Trinity',
      });
      expect(PRESENCE_REASONS.unlock('Trinity')).toBe('Unlock Trinity');
    });

    it('holds the away timer while its own prompt is open', async () => {
      const prompt = new Subject<HostPresenceOutcome>();
      const { lock } = setup({ verify: () => prompt });
      await hydrated(lock);
      const ui = TestBed.inject(HostSystemUiService);
      const pending = firstValueFrom(lock.unlockWithSystem());
      expect(ui.active()).toBe(true);
      prompt.next({ kind: 'cancelled' });
      prompt.complete();
      await expect(pending).resolves.toEqual({ kind: 'cancelled' });
      expect(ui.active()).toBe(false);
      expect(lock.status()).toBe('locked');
    });

    it('never opens two system prompts at once', async () => {
      const prompt = new Subject<HostPresenceOutcome>();
      const { lock, adapter } = setup({ verify: () => prompt });
      await hydrated(lock);
      const first = firstValueFrom(lock.unlockWithSystem());
      const second = firstValueFrom(lock.unlockWithSystem());
      expect(adapter.verify).toHaveBeenCalledOnce();
      prompt.next({ kind: 'verified' });
      prompt.complete();
      await expect(first).resolves.toEqual({ kind: 'unlocked' });
      await expect(second).resolves.toEqual({ kind: 'unlocked' });
      expect(lock.status()).toBe('unlocked');
    });

    it('shares one guard prompt between concurrent guarded changes', async () => {
      const prompt = new Subject<HostPresenceOutcome>();
      const { lock, adapter, advance } = setup({ verify: () => prompt });
      await hydrated(lock);
      await firstValueFrom(lock.unlockWithPin('482913'));
      advance(GUARD_WINDOW_MS + 1);
      const first = firstValueFrom(lock.verifyForChange());
      const second = firstValueFrom(lock.verifyForChange());
      expect(adapter.verify).toHaveBeenCalledOnce();
      prompt.next({ kind: 'verified' });
      prompt.complete();
      await expect(first).resolves.toBe('verified');
      await expect(second).resolves.toBe('verified');
    });

    it('counts a shared failed prompt once', async () => {
      const prompts: Subject<HostPresenceOutcome>[] = [];
      const { lock } = setup({
        verify: () => {
          const prompt = new Subject<HostPresenceOutcome>();
          prompts.push(prompt);
          return prompt;
        },
      });
      await hydrated(lock);
      for (let round = 0; round < 4; round += 1) {
        const first = firstValueFrom(lock.unlockWithSystem());
        const second = firstValueFrom(lock.unlockWithSystem());
        prompts[round].next({ kind: 'failed' });
        prompts[round].complete();
        await Promise.all([first, second]);
      }
      expect(prompts).toHaveLength(4);
      // Four failures, not eight: no wait yet.
      expect(lock.systemWaitUntil()).toBeNull();
    });

    it('waits after five failed prompts, never counting a cancel', async () => {
      const outcomes: HostPresenceOutcome['kind'][] = ['cancelled'];
      const { lock, advance } = setup({
        verify: () =>
          of<HostPresenceOutcome>({
            kind: outcomes.shift() === 'cancelled' ? 'cancelled' : 'failed',
          }),
      });
      await hydrated(lock);
      await expect(firstValueFrom(lock.unlockWithSystem())).resolves.toEqual({
        kind: 'cancelled',
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await firstValueFrom(lock.unlockWithSystem());
      }
      await expect(firstValueFrom(lock.unlockWithSystem())).resolves.toEqual({
        kind: 'delayed',
        until: START + 30_000,
      });
      advance(30_000);
      // The sixth failure starts the next, longer wait.
      await expect(firstValueFrom(lock.unlockWithSystem())).resolves.toEqual({
        kind: 'failed',
        until: START + 30_000 + 60_000,
      });
    });

    it('never counts a failed guard prompt toward the unlock delay', async () => {
      const { lock, advance } = setup({
        verify: () => of<HostPresenceOutcome>({ kind: 'failed' }),
      });
      await hydrated(lock);
      await firstValueFrom(lock.unlockWithPin('482913'));
      advance(GUARD_WINDOW_MS + 1);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await expect(firstValueFrom(lock.verifyForChange())).resolves.toBe(
          'cancelled',
        );
      }
      expect(lock.systemWaitUntil()).toBeNull();
    });

    it('falls back to the PIN when biometrics are locked out or the passcode is gone', async () => {
      const lockedOut = setup({
        verify: () => of<HostPresenceOutcome>({ kind: 'locked-out' }),
      });
      await hydrated(lockedOut.lock);
      await expect(
        firstValueFrom(lockedOut.lock.unlockWithSystem()),
      ).resolves.toEqual({
        kind: 'use-pin',
        reason: 'locked-out',
      });
      TestBed.resetTestingModule();
      const noPasscode = setup({
        verify: () =>
          of<HostPresenceOutcome>({
            kind: 'unavailable',
            reason: 'no-device-credential',
          }),
      });
      await hydrated(noPasscode.lock);
      await expect(
        firstValueFrom(noPasscode.lock.unlockWithSystem()),
      ).resolves.toEqual({
        kind: 'use-pin',
        reason: 'no-device-credential',
      });
      expect(noPasscode.lock.systemAvailable()).toBe(false);
    });

    it('refuses a malformed PIN without asking the host', async () => {
      const { lock, adapter } = setup();
      await hydrated(lock);
      await expect(firstValueFrom(lock.unlockWithPin('12'))).resolves.toEqual({
        kind: 'invalid',
      });
      await expect(
        firstValueFrom(lock.unlockWithPin('1'.repeat(17))),
      ).resolves.toEqual({
        kind: 'invalid',
      });
      expect(adapter.verifyPin).not.toHaveBeenCalled();
      await expect(
        firstValueFrom(lock.unlockWithPin('482913')),
      ).resolves.toEqual({
        kind: 'unlocked',
      });
    });

    it('passes a running PIN wait through', async () => {
      const { lock } = setup({
        verifyPin: () =>
          of<HostPinOutcome>({ kind: 'delayed', nextAttemptAt: 9_999_999 }),
      });
      await hydrated(lock);
      await expect(
        firstValueFrom(lock.unlockWithPin('482913')),
      ).resolves.toEqual({
        kind: 'delayed',
        until: 9_999_999,
      });
      expect(lock.status()).toBe('locked');
      expect(lock.support().pin).toEqual({
        kind: 'available',
        set: true,
        nextAttemptAt: 9_999_999,
      });
    });

    it('reads a PIN wait already in the past as retry now, without retrying', async () => {
      const { lock, adapter } = setup({
        verifyPin: () =>
          of<HostPinOutcome>({
            kind: 'delayed',
            nextAttemptAt: START - 60_000,
          }),
      });
      await hydrated(lock);
      await expect(
        firstValueFrom(lock.unlockWithPin('482913')),
      ).resolves.toEqual({
        kind: 'delayed',
        until: START,
      });
      expect(adapter.verifyPin).toHaveBeenCalledOnce();
      expect(lock.support().pin).toEqual({
        kind: 'available',
        set: true,
        nextAttemptAt: null,
      });
      expect(lock.status()).toBe('locked');
    });

    it('reads a failure whose wait is already over as no wait', async () => {
      const { lock } = setup({
        verifyPin: () =>
          of<HostPinOutcome>({ kind: 'failed', nextAttemptAt: START - 1 }),
      });
      await hydrated(lock);
      await expect(
        firstValueFrom(lock.unlockWithPin('482913')),
      ).resolves.toEqual({
        kind: 'failed',
        until: null,
      });
      expect(lock.support().pin).toEqual({
        kind: 'available',
        set: true,
        nextAttemptAt: null,
      });
    });

    it('re-locking ends the guard window', async () => {
      const { lock } = setup();
      await hydrated(lock);
      await firstValueFrom(lock.unlockWithSystem());
      expect(lock.recentlyVerified()).toBe(true);
      lock.lockNow();
      expect(lock.status()).toBe('locked');
      expect(lock.recentlyVerified()).toBe(false);
    });
  });

  describe('setup and guarded changes', () => {
    it('turns on only after the system prompt, then the PIN', async () => {
      const { lock, adapter, writes } = setup({ stored: {} });
      await hydrated(lock);
      await expect(firstValueFrom(lock.enable('482913'))).resolves.toEqual({
        kind: 'failed',
        reason: 'not-verified',
      });
      expect(adapter.setPin).not.toHaveBeenCalled();
      await firstValueFrom(lock.confirmPresence());
      expect(adapter.verify).toHaveBeenCalledWith({
        reason: 'Turn on app lock',
      });
      await expect(firstValueFrom(lock.enable('482913'))).resolves.toEqual({
        kind: 'completed',
      });
      expect(adapter.setPin).toHaveBeenCalledWith('482913');
      expect(writes.at(-1)).toEqual({
        key: 'trinity.app-lock.enabled',
        payload: '{"version":1,"value":true}',
      });
      expect(lock.status()).toBe('unlocked');
    });

    it('turns on with the PIN alone where there is no system prompt', async () => {
      const { lock } = setup({
        stored: {},
        support: {
          system: { kind: 'unavailable', reason: 'no-device-credential' },
          pin: { kind: 'available', set: false, nextAttemptAt: null },
        },
      });
      await hydrated(lock);
      await expect(firstValueFrom(lock.enable('4829'))).resolves.toEqual({
        kind: 'completed',
      });
    });

    it('is not offered, and cannot turn on, where the host reports neither method', async () => {
      // The host negotiated user-presence, but its support has nothing to offer.
      const { lock, adapter } = setup({
        stored: {},
        support: {
          system: { kind: 'unavailable', reason: 'not-supported' },
          pin: { kind: 'unavailable', reason: 'not-supported' },
        },
      });
      await hydrated(lock);
      expect(lock.offered()).toBe(false);
      await expect(firstValueFrom(lock.enable('482913'))).resolves.toEqual({
        kind: 'failed',
        reason: 'not-offered',
      });
      expect(adapter.setPin).not.toHaveBeenCalled();
      expect(lock.status()).toBe('off');
    });

    it('cannot turn on without a PIN backup, even with a system prompt', async () => {
      const { lock, adapter } = setup({
        stored: {},
        support: {
          system: { kind: 'available', biometry: 'touch-id' },
          pin: { kind: 'unavailable', reason: 'secure-storage-unavailable' },
        },
      });
      await hydrated(lock);
      expect(lock.offered()).toBe(false);
      await firstValueFrom(lock.confirmPresence());
      await expect(firstValueFrom(lock.enable('482913'))).resolves.toEqual({
        kind: 'failed',
        reason: 'not-offered',
      });
      expect(adapter.setPin).not.toHaveBeenCalled();
    });

    it('does not let enable replace the PIN of a lock that is already on', async () => {
      const { lock, adapter, advance } = setup({ support: PIN_ONLY });
      await hydrated(lock);
      await firstValueFrom(lock.unlockWithPin('482913'));
      advance(GUARD_WINDOW_MS + 1);
      await expect(firstValueFrom(lock.enable('1111'))).resolves.toEqual({
        kind: 'failed',
        reason: 'not-verified',
      });
      expect(adapter.setPin).not.toHaveBeenCalled();
    });

    it('takes the PIN back when the setting cannot be saved', async () => {
      const { lock, adapter } = setup({ stored: {}, writeFails: true });
      await hydrated(lock);
      await firstValueFrom(lock.confirmPresence());
      await expect(firstValueFrom(lock.enable('482913'))).resolves.toEqual({
        kind: 'failed',
        reason: 'setting-not-saved',
      });
      expect(adapter.clearPin).toHaveBeenCalledOnce();
      expect(lock.status()).toBe('off');
    });

    it('asks again for changes after the sixty-second window', async () => {
      const { lock, advance } = setup();
      await hydrated(lock);
      await firstValueFrom(lock.unlockWithSystem());
      await expect(firstValueFrom(lock.setLockAfter('5m'))).resolves.toEqual({
        kind: 'completed',
      });
      advance(GUARD_WINDOW_MS + 1);
      await expect(firstValueFrom(lock.setLockAfter('15m'))).resolves.toEqual({
        kind: 'failed',
        reason: 'not-verified',
      });
      await expect(firstValueFrom(lock.verifyForChange())).resolves.toBe(
        'verified',
      );
      await expect(firstValueFrom(lock.setLockAfter('15m'))).resolves.toEqual({
        kind: 'completed',
      });
      expect(lock.lockAfter()).toBe('15m');
    });

    it('guards a change with the PIN where there is no system prompt', async () => {
      const { lock, adapter, advance } = setup({ support: PIN_ONLY });
      await hydrated(lock);
      await firstValueFrom(lock.unlockWithPin('482913'));
      advance(GUARD_WINDOW_MS + 1);
      await expect(firstValueFrom(lock.verifyForChange())).resolves.toBe(
        'use-pin',
      );
      expect(adapter.verify).not.toHaveBeenCalled();
      await expect(
        firstValueFrom(lock.verifyPinForChange('482913')),
      ).resolves.toEqual({
        kind: 'unlocked',
      });
      await expect(firstValueFrom(lock.changePin('7777'))).resolves.toEqual({
        kind: 'completed',
      });
    });

    it('turns off and clears the PIN', async () => {
      const { lock, adapter } = setup();
      await hydrated(lock);
      await firstValueFrom(lock.unlockWithPin('482913'));
      await expect(firstValueFrom(lock.disable())).resolves.toEqual({
        kind: 'completed',
      });
      expect(adapter.clearPin).toHaveBeenCalledOnce();
      expect(lock.status()).toBe('off');
      lock.lockNow();
      expect(lock.status()).toBe('off');
    });

    it('stays off when the host could not clear the PIN', async () => {
      const { lock } = setup({
        clearPin: () =>
          of<HostOperationOutcome>({
            kind: 'rejected',
            diagnostic: { code: 'pin-clear-failed' },
          }),
      });
      await hydrated(lock);
      await firstValueFrom(lock.unlockWithPin('482913'));
      await expect(firstValueFrom(lock.disable())).resolves.toEqual({
        kind: 'completed',
      });
      expect(lock.status()).toBe('off');
    });
  });

  describe('PIN secrecy', () => {
    it('keeps the PIN out of logs, errors and outcomes', async () => {
      const pin = '93817264';
      const consoleCalls: unknown[] = [];
      for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          consoleCalls.push(args);
        });
      }
      const leak = () => throwError(() => new Error(`host said no to ${pin}`));
      const { lock } = setup({ verifyPin: leak, setPin: leak, clearPin: leak });
      await hydrated(lock);
      // A command that errored is recorded as such, so a failure never prints the error.
      const settle = (work: Observable<unknown>) =>
        firstValueFrom(work).catch(() => 'errored');
      const outcomes: unknown[] = [
        await settle(lock.unlockWithPin(pin)),
        await settle(lock.verifyPinForChange(pin)),
      ];
      TestBed.resetTestingModule();
      const off = setup({ stored: {}, setPin: leak, clearPin: leak });
      await hydrated(off.lock);
      await firstValueFrom(off.lock.confirmPresence());
      outcomes.push(
        await settle(off.lock.enable(pin)),
        await settle(off.lock.changePin(pin)),
      );
      const seen = JSON.stringify([outcomes, consoleCalls.map(String)]);
      expect(seen.includes(pin)).toBe(false);
      expect(outcomes).toEqual([
        { kind: 'unavailable' },
        { kind: 'unavailable' },
        { kind: 'failed', reason: 'pin-not-saved' },
        { kind: 'failed', reason: 'pin-not-saved' },
      ]);
    });
  });
});
