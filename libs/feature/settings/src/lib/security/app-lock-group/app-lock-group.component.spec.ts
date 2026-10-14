import { computed, signal } from '@angular/core';
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
import { APP_LOCK_MOBILE_OS } from './app-lock-flows';
import { AppLockGroupComponent } from './app-lock-group.component';

const PIN = '482913';
/** What the PIN dialog closes with. */
const NEW_PIN = { kind: 'pin', pin: PIN } as const;
const VERIFIED = { kind: 'verified' } as const;

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

type Command =
  'enable' | 'disable' | 'setLockAfter' | 'changePin' | 'clearUnreadablePin';

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
    /** What a successful clear of an unreadable PIN leaves the host reporting. */
    afterClear?: HostUserPresenceSupport;
    /** A phone or tablet (Touch ID falls back to a passcode there, not a password). */
    mobile?: boolean;
    /** The system-only guard's answer (replacing an unreadable PIN). */
    systemGuard?: GuardOutcome;
  } = {},
) {
  const support = signal(options.support ?? (options.enabled ? FACE_ON : FACE));
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
    support: support.asReadonly(),
    offered: computed(() => support().pin.kind === 'available'),
    systemAvailable: computed(() => support().system.kind === 'available'),
    pinState: computed(() => pinStateOf(support())),
    refreshSupport: vi.fn(() => of(support())),
    endGuardWindow: vi.fn(),
    recentlySystemVerified: vi.fn(() => false),
    verifyWithSystemForChange: vi.fn(() =>
      of<GuardOutcome>(options.systemGuard ?? 'verified'),
    ),
    clearUnreadablePin: vi.fn(() =>
      outcome('clearUnreadablePin', () =>
        support.set(
          options.afterClear ?? {
            ...support(),
            pin: { kind: 'available', set: false, nextAttemptAt: null },
          },
        ),
      ),
    ),
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
  // A dialog takes focus from its opener, as the real surface does.
  const open = vi.fn(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    return { closed: of(results.shift()) };
  });
  const view = await render(AppLockGroupComponent, {
    providers: [
      MockProvider(AppLockService, lock as never),
      MockProvider(TrnSurfaceService, { open: open as never }),
      MockProvider(TrnToastService),
      MockProvider(HostCapabilitiesService, {
        manifest: () => of(manifest(options.hostPresence ?? true)),
      }),
      { provide: APP_LOCK_MOBILE_OS, useValue: options.mobile ?? false },
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
      const { lock, open } = await setup({ dialogResults: [NEW_PIN] });
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
        dialogResults: [NEW_PIN],
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
        dialogResults: [NEW_PIN],
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
        dialogResults: [NEW_PIN],
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
          dialogResults: [NEW_PIN],
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
        dialogResults: [NEW_PIN, undefined],
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
        dialogResults: [VERIFIED],
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
        dialogResults: [VERIFIED, NEW_PIN],
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
        dialogResults: [NEW_PIN],
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
        dialogResults: [NEW_PIN],
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

    it('offers to clear a damaged PIN store while App lock is off, after Try again', async () => {
      const { lock } = await setup({
        support: PIN_UNREADABLE,
        appName: 'Trinity Next',
      });
      const note = screen.getByTestId('app-lock-pin-unreadable');
      expect(note.textContent).toContain(
        'Trinity Next can’t read the PIN stored on this device. App lock is off, so that PIN isn’t used: clearing it lets you turn App lock on with a new PIN.',
      );
      expect(note.textContent?.includes('Erase all data')).toBe(false);
      expect(screen.queryByRole('switch')).toBeNull();
      const buttons = Array.from(note.querySelectorAll('button')).map((b) =>
        b.textContent?.trim(),
      );
      expect(buttons).toEqual(['Try again', 'Clear the stored PIN']);
      await click(screen.getByRole('button', { name: 'Try again' }));
      expect(lock.refreshSupport).toHaveBeenCalledTimes(2);
      expect(lock.clearUnreadablePin).not.toHaveBeenCalled();
      expect(screen.getByRole('status').textContent?.trim()).toBe(
        'Trinity Next still can’t read the stored PIN.',
      );
    });

    it('clears it, then offers the switch and moves focus to it', async () => {
      const { lock } = await setup({ support: PIN_UNREADABLE });
      const clear = screen.getByRole('button', {
        name: 'Clear the stored PIN',
      });
      clear.focus();
      await click(clear);
      expect(lock.clearUnreadablePin).toHaveBeenCalledOnce();
      expect(lockSwitch().checked).toBe(false);
      expect(screen.getByRole('status').textContent?.trim()).toBe(
        'The stored PIN has been cleared. You can turn on App lock with a new PIN.',
      );
      await tick();
      expect(document.activeElement).toBe(lockSwitch());
    });

    it.each<[AppLockCommandOutcome & { kind: 'failed' }, string]>([
      [
        { kind: 'failed', reason: 'pin-not-cleared' },
        'Trinity couldn’t clear the stored PIN, so the stored PIN is still there. Try again.',
      ],
      [
        { kind: 'failed', reason: 'not-allowed' },
        'Trinity can’t confirm that App lock is off, so the stored PIN is still there. Restart Trinity, then try again.',
      ],
    ])(
      'keeps the note and says why when the clear gives %o',
      async (failure, text) => {
        await setup({
          support: PIN_UNREADABLE,
          failures: { clearUnreadablePin: failure },
        });
        await click(
          screen.getByRole('button', { name: 'Clear the stored PIN' }),
        );
        expect(alertText()).toBe(text);
        expect(screen.getByTestId('app-lock-pin-unreadable')).toBeTruthy();
        expect(screen.queryByRole('switch')).toBeNull();
      },
    );

    it('with the lock on and the PIN unreadable, still turns off with the system prompt', async () => {
      const { lock } = await setup({
        enabled: true,
        recentlyVerified: false,
        support: { ...PIN_UNREADABLE, system: FACE.system },
      });
      expect(
        screen.getByTestId('app-lock-pin-unreadable').textContent,
      ).toContain(
        'Use Face ID to set a new PIN, which replaces the one it can’t read, or to turn App lock off.',
      );
      await click(lockSwitch());
      expect(lock.disable).toHaveBeenCalledOnce();
    });

    it('replaces an unreadable PIN once the system prompt confirms it’s you', async () => {
      const { lock, open } = await setup({
        enabled: true,
        recentlyVerified: false,
        support: { ...PIN_UNREADABLE, system: FACE.system },
        dialogResults: [NEW_PIN],
      });
      await click(screen.getByRole('button', { name: 'Change PIN' }));
      // Only the system prompt counts here: a PIN can't be checked against a broken record.
      expect(lock.verifyWithSystemForChange).toHaveBeenCalledTimes(2);
      expect(lock.verifyForChange).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledWith(
        expect.anything(),
        setDialog('Face ID or your device passcode'),
      );
      expect(lock.changePin).toHaveBeenCalledWith(PIN);
    });

    it('changes nothing when that system prompt is cancelled', async () => {
      const { lock, open } = await setup({
        enabled: true,
        recentlyVerified: false,
        support: { ...PIN_UNREADABLE, system: FACE.system },
        systemGuard: 'cancelled',
      });
      await click(screen.getByRole('button', { name: 'Change PIN' }));
      expect(open).not.toHaveBeenCalled();
      expect(lock.changePin).not.toHaveBeenCalled();
      expect(alertText()).toBeUndefined();
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
      // No system prompt and no readable PIN: a new PIN can't be set, so it isn't offered.
      expect(
        (
          screen.getByRole('button', {
            name: 'Change PIN',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      await click(lockSwitch());
      expect(open).not.toHaveBeenCalled();
      expect(lock.disable).not.toHaveBeenCalled();
      expect(alertText()).toBe(
        'Trinity can’t read your PIN right now, so it can’t confirm it’s you. Try again.',
      );
      expect(lockSwitch().checked).toBe(true);
    });

    it('with the lock on, no system prompt and no PIN, names the way out', async () => {
      const { lock } = await setup({
        enabled: true,
        recentlyVerified: false,
        guard: 'use-pin',
        appName: 'Trinity Next',
        support: {
          system: { kind: 'unavailable', reason: 'not-supported' },
          pin: { kind: 'available', set: false, nextAttemptAt: null },
        },
      });
      expect(screen.getByTestId('app-lock-no-pin').textContent?.trim()).toBe(
        'There’s no Trinity Next PIN on this device, so Trinity Next can’t confirm changes to App lock. To turn it off, erase all data on this device: choose Add account, then Erase all data on this device on the sign-in page.',
      );
      expect(
        (
          screen.getByRole('button', {
            name: 'Change PIN',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      await click(lockSwitch('Lock Trinity Next'));
      expect(lock.disable).not.toHaveBeenCalled();
      expect(alertText()).toBe(
        'There’s no Trinity Next PIN on this device to confirm it’s you. To turn App lock off, choose Add account, then Erase all data on this device on the sign-in page.',
      );
    });
  });

  describe('Settings left', () => {
    it('ends the guard window when the group goes away', async () => {
      const { lock, view } = await setup({ enabled: true });
      expect(lock.endGuardWindow).not.toHaveBeenCalled();
      view.fixture.destroy();
      expect(lock.endGuardWindow).toHaveBeenCalledOnce();
    });
  });

  describe('Touch ID’s fallback', () => {
    const TOUCH: HostUserPresenceSupport = {
      system: { kind: 'available', biometry: 'touch-id' },
      pin: { kind: 'available', set: false, nextAttemptAt: null },
    };

    it('is the device passcode on iPhone and iPad', async () => {
      const { open } = await setup({
        support: TOUCH,
        mobile: true,
        dialogResults: [NEW_PIN],
      });
      await click(lockSwitch());
      expect(open).toHaveBeenCalledWith(
        expect.anything(),
        setDialog('Touch ID or your device passcode'),
      );
    });

    it('is the device password on a Mac', async () => {
      const { open } = await setup({
        support: TOUCH,
        mobile: false,
        dialogResults: [NEW_PIN],
      });
      await click(lockSwitch());
      expect(open).toHaveBeenCalledWith(
        expect.anything(),
        setDialog('Touch ID or your device password'),
      );
    });
  });

  describe('focus', () => {
    it('comes back to Change PIN once its dialogs close', async () => {
      await setup({ enabled: true, dialogResults: [NEW_PIN] });
      const change = screen.getByRole('button', { name: 'Change PIN' });
      change.focus();
      await click(change);
      await tick();
      expect(document.activeElement).toBe(change);
    });

    it('comes back to the switch when turning on is cancelled', async () => {
      await setup({ dialogResults: [undefined] });
      lockSwitch().focus();
      await click(lockSwitch());
      await tick();
      expect(document.activeElement).toBe(lockSwitch());
    });

    it('leaves focus alone when it already went somewhere else', async () => {
      await setup({ enabled: true, dialogResults: [NEW_PIN] });
      const change = screen.getByRole('button', { name: 'Change PIN' });
      const elsewhere = document.createElement('button');
      document.body.append(elsewhere);
      onTestFinished(() => elsewhere.remove());
      change.focus();
      fireEvent.click(change);
      elsewhere.focus();
      await tick();
      expect(document.activeElement).toBe(elsewhere);
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

    it('draws no divider under a lone switch row', async () => {
      await setup({ enabled: false });
      expect(
        screen.getByTestId('app-lock-enabled').classList.contains('border-b'),
      ).toBe(false);
    });

    it('divides the switch row from the options while the lock is on', async () => {
      await setup({ enabled: true });
      expect(
        screen.getByTestId('app-lock-enabled').classList.contains('border-b'),
      ).toBe(true);
    });

    it('names the Lock after select by its row label', async () => {
      await setup({ enabled: true });
      expect(screen.getByRole('combobox', { name: 'Lock after' })).toBeTruthy();
    });
  });
});
