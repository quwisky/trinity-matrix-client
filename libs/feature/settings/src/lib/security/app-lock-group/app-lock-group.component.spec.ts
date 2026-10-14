import { signal } from '@angular/core';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  AppLockService,
  type AppLockCommandOutcome,
  type AppLockPinState,
  type GuardOutcome,
  type LockAfter,
} from '@trinity/data-access/app-lock';
import {
  HostCapabilitiesService,
  unavailableHostManifest,
  type HostCapabilityManifest,
  type HostPresenceOutcome,
  type HostUserPresenceSupport,
} from '@trinity/runtime/host';
import { fireEvent, render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { AppLockGroupComponent } from './app-lock-group.component';

const PIN = '482913';

/** One macrotask for the zoneless renderer. */
const tick = () => new Promise((resolve) => setTimeout(resolve));

async function click(element: Element): Promise<void> {
  fireEvent.click(element);
  await tick();
}

const FACE: HostUserPresenceSupport = {
  system: { kind: 'available', biometry: 'face' },
  pin: { kind: 'available', set: false, nextAttemptAt: null },
};
/** Face ID with a PIN stored: the lock is on. */
const FACE_ON: HostUserPresenceSupport = {
  ...FACE,
  pin: { kind: 'available', set: true, nextAttemptAt: null },
};
const PIN_ONLY: HostUserPresenceSupport = {
  system: { kind: 'unavailable', reason: 'not-supported' },
  pin: { kind: 'available', set: true, nextAttemptAt: null },
};
/** A PIN store that exists but cannot be read (a damaged record, a locked keyring). */
const PIN_UNREADABLE: HostUserPresenceSupport = {
  system: { kind: 'unavailable', reason: 'not-supported' },
  pin: { kind: 'unavailable', reason: 'secure-storage-unavailable' },
};
/** No PIN store: the web, or a desktop without usable encryption (Linux `basic_text`). */
const NO_PIN_STORE: HostUserPresenceSupport = {
  system: { kind: 'unavailable', reason: 'not-supported' },
  pin: { kind: 'unavailable', reason: 'not-supported' },
};

type Command = 'enable' | 'disable' | 'setLockAfter' | 'changePin';

function pinStateOf(support: HostUserPresenceSupport): AppLockPinState {
  const pin = support.pin;
  if (pin.kind === 'available') return pin.set ? 'ready' : 'not-set';
  return pin.reason === 'not-supported' ? 'not-supported' : 'unreadable';
}

function manifest(userPresence: boolean): HostCapabilityManifest {
  const base = unavailableHostManifest('not-supported');
  return {
    ...base,
    operations: {
      ...base.operations,
      'user-presence': userPresence
        ? { kind: 'supported' }
        : base.operations['user-presence'],
    },
  };
}

async function setup(
  options: {
    enabled?: boolean;
    lockAfter?: LockAfter;
    support?: HostUserPresenceSupport;
    /** Whether the host offers the user-presence operation (false on the web). */
    hostPresence?: boolean;
    /** What each PIN dialog closes with, in order. */
    dialogResults?: unknown[];
    guard?: GuardOutcome;
    presence?: HostPresenceOutcome;
    recentlyVerified?: boolean | (() => boolean);
    failures?: Partial<Record<Command, AppLockCommandOutcome>>;
    appName?: string;
  } = {},
) {
  const support = options.support ?? (options.enabled ? FACE_ON : FACE);
  const enabled = signal(options.enabled ?? false);
  const lockAfter = signal<LockAfter>(options.lockAfter ?? '1m');
  const results = [...(options.dialogResults ?? [])];
  const recent = options.recentlyVerified ?? true;
  const outcome = (
    command: Command,
    apply: () => void,
  ): ReturnType<AppLockService['enable']> => {
    const failure = options.failures?.[command];
    if (failure) return of(failure);
    apply();
    return of<AppLockCommandOutcome>({ kind: 'completed' });
  };
  const lock = {
    appName: options.appName ?? 'Trinity',
    enabled: enabled.asReadonly(),
    lockAfter: lockAfter.asReadonly(),
    support: signal(support).asReadonly(),
    offered: signal(support.pin.kind === 'available').asReadonly(),
    systemAvailable: signal(support.system.kind === 'available').asReadonly(),
    pinState: signal(pinStateOf(support)).asReadonly(),
    refreshSupport: vi.fn(() => of(support)),
    recentlyVerified: vi.fn(
      typeof recent === 'function' ? recent : () => recent,
    ),
    confirmPresence: vi.fn(() =>
      of<HostPresenceOutcome>(options.presence ?? { kind: 'verified' }),
    ),
    enable: vi.fn((_pin: string) => outcome('enable', () => enabled.set(true))),
    verifyForChange: vi.fn(() => of<GuardOutcome>(options.guard ?? 'verified')),
    disable: vi.fn(() => outcome('disable', () => enabled.set(false))),
    setLockAfter: vi.fn((value: LockAfter) =>
      outcome('setLockAfter', () => lockAfter.set(value)),
    ),
    changePin: vi.fn((_pin: string) => outcome('changePin', () => undefined)),
  };
  const open = vi.fn(() => ({ closed: of(results.shift()) }));
  const view = await render(AppLockGroupComponent, {
    providers: [
      MockProvider(AppLockService, lock as never),
      MockProvider(TrnSurfaceService, { open: open as never }),
      MockProvider(TrnToastService),
      MockProvider(HostCapabilitiesService, {
        manifest: () => of(manifest(options.hostPresence ?? true)),
      }),
    ],
  });
  return { lock, open, view };
}

function lockSwitch(name = 'Lock Trinity'): HTMLInputElement {
  return screen.getByRole('switch', { name }) as HTMLInputElement;
}

function alertText(): string | undefined {
  return screen.queryByRole('alert')?.textContent?.trim();
}

const setDialog = (methodName: string | null) =>
  expect.objectContaining({ inputs: { mode: 'set', methodName } });
const verifyDialog = (methodName: string | null) =>
  expect.objectContaining({ inputs: { mode: 'verify', methodName } });

describe('AppLockGroupComponent', () => {
  describe('turning it on', () => {
    it('runs the system prompt, then asks for a PIN', async () => {
      const { lock, open } = await setup({ dialogResults: [PIN] });
      expect(lockSwitch().checked).toBe(false);
      await click(lockSwitch());
      expect(lock.confirmPresence).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledWith(
        expect.anything(),
        setDialog('Face ID or your device passcode'),
      );
      expect(lock.enable).toHaveBeenCalledWith(PIN);
      expect(lockSwitch().checked).toBe(true);
      expect(alertText()).toBeUndefined();
    });

    it('goes straight to the PIN where there is no system prompt', async () => {
      const { lock, open } = await setup({
        support: { ...PIN_ONLY, pin: { ...PIN_ONLY.pin, set: false } as never },
        dialogResults: [PIN],
      });
      await click(lockSwitch());
      expect(lock.confirmPresence).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledWith(expect.anything(), setDialog(null));
      expect(lock.enable).toHaveBeenCalledWith(PIN);
    });

    it('stays off, saying nothing, when the system prompt is cancelled', async () => {
      const { lock, open } = await setup({ presence: { kind: 'cancelled' } });
      await click(lockSwitch());
      expect(open).not.toHaveBeenCalled();
      expect(lock.enable).not.toHaveBeenCalled();
      expect(alertText()).toBeUndefined();
      expect(lockSwitch().checked).toBe(false);
    });

    it.each<HostPresenceOutcome>([
      { kind: 'locked-out' },
      { kind: 'rejected', diagnostic: { code: 'presence-failed' } },
    ])(
      'stays off and says so when the system prompt gives $kind',
      async (presence) => {
        const { lock, open } = await setup({ presence });
        await click(lockSwitch());
        expect(open).not.toHaveBeenCalled();
        expect(lock.enable).not.toHaveBeenCalled();
        expect(alertText()).toBe(
          'Trinity couldn’t confirm it’s you, so App lock is still off. Try again.',
        );
      },
    );

    it('falls back to the PIN alone when the system prompt turns out unavailable', async () => {
      const { lock, open } = await setup({
        presence: { kind: 'unavailable', reason: 'not-enrolled' },
        dialogResults: [PIN],
      });
      await click(lockSwitch());
      expect(open).toHaveBeenCalledOnce();
      expect(lock.enable).toHaveBeenCalledWith(PIN);
    });

    it('stays off when the PIN dialog is cancelled', async () => {
      const { lock } = await setup({ dialogResults: [undefined] });
      await click(lockSwitch());
      expect(lock.enable).not.toHaveBeenCalled();
      expect(lockSwitch().checked).toBe(false);
      expect(alertText()).toBeUndefined();
    });

    it('asks the system prompt again when the PIN took longer than the guard window', async () => {
      const { lock } = await setup({
        dialogResults: [PIN],
        // The window closed while the PIN was typed.
        recentlyVerified: false,
      });
      await click(lockSwitch());
      expect(lock.confirmPresence).toHaveBeenCalledTimes(2);
      expect(lock.enable).toHaveBeenCalledWith(PIN);
    });

    it.each<[AppLockCommandOutcome & { kind: 'failed' }, string]>([
      [
        { kind: 'failed', reason: 'not-offered' },
        'Trinity can’t keep a PIN on this device right now, so App lock is still off.',
      ],
      [
        { kind: 'failed', reason: 'not-verified' },
        'Trinity couldn’t confirm it’s you, so App lock is still off. Try again.',
      ],
      [
        { kind: 'failed', reason: 'pin-invalid' },
        'A PIN needs 4 to 16 digits, so App lock is still off. Try again.',
      ],
      [
        { kind: 'failed', reason: 'pin-not-saved' },
        'Trinity couldn’t save your PIN, so App lock is still off. Try again.',
      ],
      [
        { kind: 'failed', reason: 'setting-not-saved' },
        'Trinity couldn’t save this setting, so App lock is still off. Try again.',
      ],
    ])(
      'shows the switch off and says why when enable gives %o',
      async (failure, text) => {
        const { lock } = await setup({
          dialogResults: [PIN],
          failures: { enable: failure },
        });
        await click(lockSwitch());
        expect(alertText()).toBe(text);
        expect(lockSwitch().checked).toBe(false);
        expect(lockSwitch().disabled).toBe(false);
        // The group re-reads what the host can do, so its view follows the store.
        expect(lock.refreshSupport).toHaveBeenCalledTimes(2);
      },
    );

    it('clears an earlier message when the next attempt starts', async () => {
      await setup({
        dialogResults: [PIN, undefined],
        failures: { enable: { kind: 'failed', reason: 'pin-not-saved' } },
      });
      await click(lockSwitch());
      expect(alertText()).toBeTruthy();
      await click(lockSwitch());
      expect(alertText()).toBeUndefined();
    });
  });

  describe('turning it off', () => {
    it('turns off after the system prompt confirms it’s you', async () => {
      const { lock, open } = await setup({
        enabled: true,
        recentlyVerified: false,
      });
      await click(lockSwitch());
      expect(lock.verifyForChange).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();
      expect(lock.disable).toHaveBeenCalledOnce();
      expect(lockSwitch().checked).toBe(false);
    });

    it('asks for the current PIN when the system prompt cannot confirm a change', async () => {
      const { lock, open } = await setup({
        enabled: true,
        recentlyVerified: false,
        guard: 'use-pin',
        dialogResults: ['verified'],
      });
      await click(lockSwitch());
      expect(open).toHaveBeenCalledWith(
        expect.anything(),
        verifyDialog('Face ID or your device passcode'),
      );
      expect(lock.disable).toHaveBeenCalledOnce();
    });

    it('needs no new check inside the guard window', async () => {
      const { lock } = await setup({ enabled: true, recentlyVerified: true });
      await click(lockSwitch());
      expect(lock.verifyForChange).not.toHaveBeenCalled();
      expect(lock.disable).toHaveBeenCalledOnce();
    });

    it('stays on when the check is cancelled', async () => {
      const { lock } = await setup({
        enabled: true,
        recentlyVerified: false,
        guard: 'cancelled',
      });
      await click(lockSwitch());
      expect(lock.disable).not.toHaveBeenCalled();
      expect(lockSwitch().checked).toBe(true);
      expect(alertText()).toBeUndefined();
    });

    it('stays on when the PIN dialog is cancelled', async () => {
      const { lock } = await setup({
        enabled: true,
        recentlyVerified: false,
        guard: 'use-pin',
        dialogResults: [undefined],
      });
      await click(lockSwitch());
      expect(lock.disable).not.toHaveBeenCalled();
      expect(lockSwitch().checked).toBe(true);
    });

    it.each<[AppLockCommandOutcome & { kind: 'failed' }, string]>([
      [
        { kind: 'failed', reason: 'not-verified' },
        'Trinity couldn’t confirm it’s you, so App lock is still on. Try again.',
      ],
      [
        { kind: 'failed', reason: 'setting-not-saved' },
        'Trinity couldn’t save this setting, so App lock is still on. Try again.',
      ],
    ])('stays on and says why when disable gives %o', async (failure, text) => {
      await setup({ enabled: true, failures: { disable: failure } });
      await click(lockSwitch());
      expect(alertText()).toBe(text);
      expect(lockSwitch().checked).toBe(true);
    });
  });

  describe('Lock after', () => {
    function chooseLockAfter(
      view: Awaited<ReturnType<typeof setup>>['view'],
      testId: string,
    ) {
      // jsdom has no scrollIntoView, which Brain calls when an option becomes active.
      Element.prototype.scrollIntoView = vi.fn();
      onTestFinished(() => {
        Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
      });
      const trigger = screen.getByRole('combobox', { name: 'Lock after' });
      fireEvent.click(trigger);
      view.fixture.detectChanges();
      fireEvent.click(
        document.querySelector(`[data-testid=${testId}]`) as Element,
      );
      view.fixture.detectChanges();
    }

    function shownLockAfter(): string | undefined {
      return screen
        .getByRole('combobox', { name: 'Lock after' })
        .textContent?.trim();
    }

    it('changes after a fresh check', async () => {
      const { lock, view } = await setup({
        enabled: true,
        recentlyVerified: false,
      });
      expect(shownLockAfter()).toBe('After 1 minute');
      chooseLockAfter(view, 'app-lock-after-5m');
      await view.fixture.whenStable();
      expect(lock.verifyForChange).toHaveBeenCalledOnce();
      expect(lock.setLockAfter).toHaveBeenCalledWith('5m');
      expect(shownLockAfter()).toBe('After 5 minutes');
    });

    it('keeps showing the old value when the check is cancelled', async () => {
      const { lock, view } = await setup({
        enabled: true,
        recentlyVerified: false,
        guard: 'cancelled',
      });
      chooseLockAfter(view, 'app-lock-after-immediately');
      await view.fixture.whenStable();
      view.fixture.detectChanges();
      expect(lock.setLockAfter).not.toHaveBeenCalled();
      expect(shownLockAfter()).toBe('After 1 minute');
    });

    it('keeps the old value and says so when it cannot be saved', async () => {
      const { view } = await setup({
        enabled: true,
        failures: {
          setLockAfter: { kind: 'failed', reason: 'setting-not-saved' },
        },
      });
      chooseLockAfter(view, 'app-lock-after-60m');
      await view.fixture.whenStable();
      view.fixture.detectChanges();
      expect(alertText()).toBe(
        'Trinity couldn’t save this setting, so Lock after hasn’t changed. Try again.',
      );
      expect(shownLockAfter()).toBe('After 1 minute');
    });

    it('is shown only while the lock is on', async () => {
      await setup({ enabled: false });
      expect(screen.queryByTestId('app-lock-after')).toBeNull();
      expect(screen.queryByTestId('app-lock-change-pin')).toBeNull();
    });
  });

  describe('Change PIN', () => {
    it('asks for the new PIN twice after a fresh check, then saves it', async () => {
      let checks = 0;
      const { lock, open } = await setup({
        enabled: true,
        // Not yet verified; the PIN check then opens the window.
        recentlyVerified: () => checks++ > 0,
        guard: 'use-pin',
        dialogResults: ['verified', PIN],
      });
      await click(screen.getByRole('button', { name: 'Change PIN' }));
      expect(open).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        verifyDialog('Face ID or your device passcode'),
      );
      expect(open).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        setDialog('Face ID or your device passcode'),
      );
      expect(lock.changePin).toHaveBeenCalledWith(PIN);
      expect(screen.getByRole('status').textContent?.trim()).toBe(
        'Your PIN has been changed.',
      );
    });

    it('checks again when the new PIN took longer than the guard window', async () => {
      let checks = 0;
      const { lock } = await setup({
        enabled: true,
        dialogResults: [PIN],
        recentlyVerified: () => checks++ === 0,
      });
      await click(screen.getByRole('button', { name: 'Change PIN' }));
      expect(lock.verifyForChange).toHaveBeenCalledOnce();
      expect(lock.changePin).toHaveBeenCalledWith(PIN);
    });

    it('changes nothing when the new PIN is cancelled', async () => {
      const { lock } = await setup({
        enabled: true,
        dialogResults: [undefined],
      });
      await click(screen.getByRole('button', { name: 'Change PIN' }));
      expect(lock.changePin).not.toHaveBeenCalled();
      expect(screen.getByRole('status').textContent?.trim()).toBe('');
    });

    it.each<[AppLockCommandOutcome & { kind: 'failed' }, string]>([
      [
        { kind: 'failed', reason: 'pin-not-saved' },
        'Trinity couldn’t save your PIN, so your PIN hasn’t changed. Try again.',
      ],
      [
        { kind: 'failed', reason: 'pin-invalid' },
        'A PIN needs 4 to 16 digits, so your PIN hasn’t changed. Try again.',
      ],
      [
        { kind: 'failed', reason: 'not-verified' },
        'Trinity couldn’t confirm it’s you, so your PIN hasn’t changed. Try again.',
      ],
    ])('says why when changePin gives %o', async (failure, text) => {
      await setup({
        enabled: true,
        dialogResults: [PIN],
        failures: { changePin: failure },
      });
      await click(screen.getByRole('button', { name: 'Change PIN' }));
      expect(alertText()).toBe(text);
    });
  });

  describe('what this device offers', () => {
    it('suggests a screen lock on a device without one, without requiring it', async () => {
      await setup({
        enabled: true,
        support: {
          system: { kind: 'unavailable', reason: 'no-device-credential' },
          pin: { kind: 'available', set: true, nextAttemptAt: null },
        },
      });
      expect(
        screen.getByTestId('app-lock-screen-lock-hint').textContent,
      ).toContain('This device has no screen lock');
      expect(lockSwitch()).toBeTruthy();
    });

    it('explains a missing keyring instead of offering the switch', async () => {
      await setup({ support: NO_PIN_STORE, hostPresence: true });
      expect(screen.getByTestId('app-lock-group')).toBeTruthy();
      expect(screen.getByTestId('app-lock-keyring').textContent).toContain(
        'keyring',
      );
      expect(screen.queryByRole('switch')).toBeNull();
    });

    it('shows nothing where App lock does not exist (the web)', async () => {
      await setup({ support: NO_PIN_STORE, hostPresence: false });
      expect(screen.queryByTestId('app-lock-group')).toBeNull();
    });

    it('says a damaged PIN store blocks turning it on until the full reset', async () => {
      const { lock } = await setup({
        support: PIN_UNREADABLE,
        appName: 'Trinity Next',
      });
      const note = screen.getByTestId('app-lock-pin-unreadable').textContent;
      expect(note).toContain(
        'Trinity Next can’t read the PIN stored on this device, so App lock can’t be turned on.',
      );
      expect(note).toContain('Erase all data on this device');
      expect(screen.queryByRole('switch')).toBeNull();
      await click(screen.getByRole('button', { name: 'Try again' }));
      expect(lock.refreshSupport).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('status').textContent?.trim()).toBe(
        'Trinity Next still can’t read the stored PIN.',
      );
    });

    it('with the lock on and the PIN unreadable, still turns off with the system prompt', async () => {
      const { lock } = await setup({
        enabled: true,
        recentlyVerified: false,
        support: { ...PIN_UNREADABLE, system: FACE.system },
      });
      expect(
        screen.getByTestId('app-lock-pin-unreadable').textContent,
      ).toContain('Use Face ID to change App lock or turn it off.');
      await click(lockSwitch());
      expect(lock.disable).toHaveBeenCalledOnce();
    });

    it('with the lock on and no way to check, says how to get out instead of a dead PIN dialog', async () => {
      const { lock, open } = await setup({
        enabled: true,
        recentlyVerified: false,
        guard: 'use-pin',
        support: PIN_UNREADABLE,
      });
      expect(
        screen.getByTestId('app-lock-pin-unreadable').textContent,
      ).toContain('lock Trinity and choose Erase all data on this device');
      await click(lockSwitch());
      expect(open).not.toHaveBeenCalled();
      expect(lock.disable).not.toHaveBeenCalled();
      expect(alertText()).toBe(
        'Trinity can’t read your PIN right now, so it can’t confirm it’s you. Try again.',
      );
      expect(lockSwitch().checked).toBe(true);
    });
  });

  describe('accessibility', () => {
    it('names and describes the switch in its row, with the running app’s name', async () => {
      await setup({ appName: 'Trinity Next' });
      const control = lockSwitch('Lock Trinity Next');
      expect(control).toHaveAccessibleDescription(
        'Unlock with Face ID, or with a Trinity Next PIN you set now.',
      );
    });

    it('describes a PIN-only lock without a system method', async () => {
      await setup({ support: PIN_ONLY });
      expect(lockSwitch()).toHaveAccessibleDescription(
        'Unlock with a Trinity PIN you set now.',
      );
    });

    it('names the Lock after select by its row label', async () => {
      await setup({ enabled: true });
      expect(screen.getByRole('combobox', { name: 'Lock after' })).toBeTruthy();
    });
  });
});
