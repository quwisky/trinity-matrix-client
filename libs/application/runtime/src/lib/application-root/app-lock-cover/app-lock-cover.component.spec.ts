import { computed, signal } from '@angular/core';
import { provideTrnIcons } from '@trinity/components/foundations';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import {
  AppLockService,
  type AppLockPinState,
  type UnlockOutcome,
} from '@trinity/data-access/app-lock';
import { AppRestartService } from '@trinity/platform-native';
import {
  HostLifecycleService,
  HostLockIntegrationService,
  HostSystemUiService,
  type HostUserPresenceSupport,
} from '@trinity/runtime/host';
import {
  desktopBridgeFixture,
  fireEvent,
  render,
  screen,
} from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, of, type Observable } from 'rxjs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppLockCoverComponent } from './app-lock-cover.component';

const FACE: HostUserPresenceSupport = {
  system: { kind: 'available', biometry: 'face' },
  pin: { kind: 'available', set: true, nextAttemptAt: null },
};
const PIN_ONLY: HostUserPresenceSupport = {
  system: { kind: 'unavailable', reason: 'not-supported' },
  pin: { kind: 'available', set: true, nextAttemptAt: null },
};
const FACE_UNREADABLE_PIN: HostUserPresenceSupport = {
  system: { kind: 'available', biometry: 'face' },
  pin: { kind: 'unavailable', reason: 'secure-storage-unavailable' },
};
const UNREADABLE_ONLY: HostUserPresenceSupport = {
  system: { kind: 'unavailable', reason: 'not-supported' },
  pin: { kind: 'unavailable', reason: 'secure-storage-unavailable' },
};
const NO_PIN_ONLY: HostUserPresenceSupport = {
  system: { kind: 'unavailable', reason: 'not-supported' },
  pin: { kind: 'available', set: false, nextAttemptAt: null },
};
const NO_PIN_STORE_ONLY: HostUserPresenceSupport = {
  system: { kind: 'unavailable', reason: 'not-supported' },
  pin: { kind: 'unavailable', reason: 'not-supported' },
};
/** A fixture PIN; R8 allows it in call assertions against mocks, never in rendered text. */
const FIXTURE_PIN = '482913';

function pinStateOf(support: HostUserPresenceSupport): AppLockPinState {
  const pin = support.pin;
  if (pin.kind === 'available') return pin.set ? 'ready' : 'not-set';
  return pin.reason === 'not-supported' ? 'not-supported' : 'unreadable';
}

beforeAll(() => {
  // jsdom has no top layer; record the call as an open attribute.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
});

async function setup(
  options: {
    locked?: boolean;
    support?: HostUserPresenceSupport;
    /** What `refreshSupport` reads from the host; the support so far by default. */
    refreshed?: HostUserPresenceSupport;
    system?: () => Observable<UnlockOutcome>;
    pin?: () => Observable<UnlockOutcome>;
    appName?: string;
    systemWaitUntil?: number | null;
    desktop?: boolean;
    reset?: () => Observable<unknown>;
  } = {},
) {
  if (options.desktop) {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture();
  }
  const locked = signal(options.locked ?? true);
  const support = signal(options.support ?? FACE);
  const systemAvailable = computed(() => support().system.kind === 'available');
  const pinState = computed(() => pinStateOf(support()));
  const systemWaitUntil = signal<number | null>(
    options.systemWaitUntil ?? null,
  );
  const unlockWithSystem = vi.fn(
    options.system ?? (() => of<UnlockOutcome>({ kind: 'cancelled' })),
  );
  const unlockWithPin = vi.fn(
    options.pin ?? (() => of<UnlockOutcome>({ kind: 'unlocked' })),
  );
  const refreshSupport = vi.fn(() => {
    if (options.refreshed) support.set(options.refreshed);
    return of(support());
  });
  const retry = vi.fn(() => of(undefined));
  const lifecycle = new Subject<{ readonly kind: 'active' | 'background' }>();
  const systemUiActive = signal(false);
  const coverPainted = vi.fn(() => of({ kind: 'completed' as const }));
  const resetInstallation = vi.fn(
    options.reset ?? (() => of({ kind: 'ready' as const })),
  );
  const restart = vi.fn();
  const rendered = await render(AppLockCoverComponent, {
    providers: [
      provideTrnIcons(),
      MockProvider(AppLockService, {
        appName: options.appName ?? 'Trinity',
        locked: locked.asReadonly(),
        support: support.asReadonly(),
        systemAvailable,
        pinState,
        recoveryOnly: computed(
          () => locked() && !systemAvailable() && pinState() !== 'ready',
        ),
        systemWaitUntil: systemWaitUntil.asReadonly(),
        refreshSupport,
        retry,
        unlockWithSystem,
        unlockWithPin,
      }),
      MockProvider(HostLifecycleService, { events: lifecycle }),
      MockProvider(HostLockIntegrationService, { coverPainted }),
      MockProvider(HostSystemUiService, {
        active: systemUiActive.asReadonly(),
      }),
      MockProvider(AccountRuntimeService, {
        resetInstallation: resetInstallation as never,
      }),
      MockProvider(AppRestartService, { restart }),
    ],
  });
  const dialog = rendered.container.querySelector(
    'dialog',
  ) as HTMLDialogElement;
  const settle = async (): Promise<void> => {
    rendered.fixture.detectChanges();
    await rendered.fixture.whenStable();
  };
  return {
    ...rendered,
    dialog,
    locked,
    support,
    systemWaitUntil,
    lifecycle,
    systemUiActive,
    unlockWithSystem,
    unlockWithPin,
    refreshSupport,
    retry,
    coverPainted,
    resetInstallation,
    restart,
    settle,
  };
}

/**
 * Holds `requestAnimationFrame` callbacks; `frame()` runs the ones queued so far, as one frame.
 * Angular's zoneless scheduler also asks for frames, so a frame runs everything queued.
 */
function holdFrames(): { frame(): void } {
  const queued: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queued.push(callback);
    return queued.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  return {
    frame: () => {
      for (const callback of queued.splice(0)) callback(0);
    },
  };
}

/** A click, then a tick for the zoneless renderer. */
async function click(element: Element): Promise<void> {
  fireEvent.click(element);
  await new Promise((resolve) => setTimeout(resolve));
}

/** Types `value` into a field as one input event. */
async function type(element: Element, value: string): Promise<void> {
  fireEvent.input(element, { target: { value } });
  await new Promise((resolve) => setTimeout(resolve));
}

const pinField = (appName = 'Trinity') =>
  screen.getByLabelText(`${appName} PIN`) as HTMLInputElement;

describe('AppLockCoverComponent', () => {
  describe('the cover', () => {
    it('opens the cover in the first frame when the lock is on', async () => {
      const { dialog } = await setup();
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(
        screen.getByRole('heading', { name: 'Trinity is locked' }),
      ).toBeTruthy();
    });

    it('names the running app: Trinity Next is locked', async () => {
      await setup({ appName: 'Trinity Next', support: PIN_ONLY });
      expect(
        screen.getByRole('dialog', { name: 'Trinity Next is locked' }),
      ).toBeTruthy();
      expect(pinField('Trinity Next')).toBeTruthy();
    });

    it('stays closed while nothing is locked', async () => {
      const { dialog, coverPainted } = await setup({ locked: false });
      expect(dialog.hasAttribute('open')).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(coverPainted).not.toHaveBeenCalled();
    });

    it('closes the cover once unlocked', async () => {
      const { dialog, locked, settle } = await setup();
      locked.set(false);
      await settle();
      expect(dialog.hasAttribute('open')).toBe(false);
    });

    it('is a dialog named by its heading', async () => {
      await setup();
      expect(
        screen.getByRole('dialog', { name: 'Trinity is locked' }),
      ).toBeTruthy();
    });

    it('shows only the mark, the heading and the unlock control', async () => {
      const { dialog } = await setup();
      const images = dialog.querySelectorAll('img');
      expect(images).toHaveLength(1);
      expect(images[0].getAttribute('src')).toBe('assets/icon/icon-plated.svg');
      expect(images[0].getAttribute('alt')).toBe('');
      const text = (dialog.textContent ?? '').replace(/\s+/g, ' ').trim();
      expect(text).toBe(
        'Trinity is locked Unlock with Face ID Use PIN instead',
      );
      expect(
        screen.getAllByRole('button').map((b) => b.textContent?.trim()),
      ).toEqual(['Unlock with Face ID', 'Use PIN instead']);
    });

    it('reserves the region above the lock for calls', async () => {
      await setup();
      const region = screen.getByTestId('app-lock-above-lock');
      expect(region.textContent?.trim()).toBe('');
    });
  });

  describe('telling the shell it painted', () => {
    it('tells the shell once the cover has painted', async () => {
      const { coverPainted } = await setup();
      await vi.waitFor(() => expect(coverPainted).toHaveBeenCalledOnce(), {
        timeout: 1_000,
      });
    });

    it('waits two animation frames before it tells the shell', async () => {
      const frames = holdFrames();
      const { coverPainted } = await setup();
      expect(coverPainted).not.toHaveBeenCalled();
      frames.frame();
      expect(coverPainted).not.toHaveBeenCalled();
      frames.frame();
      expect(coverPainted).toHaveBeenCalledOnce();
    });

    it('a reloaded renderer that starts locked tells the shell after its first paint', async () => {
      // A reload (or a recovery reload) mounts a fresh cover with the lock already on.
      const { coverPainted, dialog } = await setup({ support: PIN_ONLY });
      expect(dialog.hasAttribute('open')).toBe(true);
      await vi.waitFor(() => expect(coverPainted).toHaveBeenCalledOnce(), {
        timeout: 1_000,
      });
    });

    it('tells the shell again each time the app locks', async () => {
      const { coverPainted, locked, settle } = await setup({ locked: false });
      locked.set(true);
      await settle();
      await vi.waitFor(() => expect(coverPainted).toHaveBeenCalledTimes(1), {
        timeout: 1_000,
      });
      locked.set(false);
      await settle();
      locked.set(true);
      await settle();
      await vi.waitFor(() => expect(coverPainted).toHaveBeenCalledTimes(2), {
        timeout: 1_000,
      });
    });

    it('never tells the shell for a cover that closed before it painted', async () => {
      const frames = holdFrames();
      const { coverPainted, locked, settle } = await setup();
      locked.set(false);
      await settle();
      frames.frame();
      frames.frame();
      frames.frame();
      expect(coverPainted).not.toHaveBeenCalled();
    });

    it('stays open while a locked app is hidden and shown again', async () => {
      // The lifecycle binding re-sends the signal on show; it needs the cover still painted.
      const { dialog, lifecycle, settle } = await setup();
      lifecycle.next({ kind: 'background' });
      lifecycle.next({ kind: 'active' });
      await settle();
      expect(dialog.hasAttribute('open')).toBe(true);
    });
  });

  describe('dismissal and keys', () => {
    it('does not close on Escape', async () => {
      const { dialog } = await setup();
      const cancel = new Event('cancel', { cancelable: true });
      dialog.dispatchEvent(cancel);
      expect(cancel.defaultPrevented).toBe(true);
      const escape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      dialog.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(true);
      expect(dialog.hasAttribute('open')).toBe(true);
    });

    it('opens again where it was if anything closes it while locked', async () => {
      const { dialog, settle } = await setup();
      await click(screen.getByRole('button', { name: 'Use PIN instead' }));
      dialog.close();
      await settle();
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(pinField()).toBeTruthy();
    });

    it('keeps keystrokes away from the page’s shortcuts', async () => {
      const { dialog } = await setup();
      const pageShortcut = vi.fn();
      document.addEventListener('keydown', pageShortcut);
      dialog.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'k',
          ctrlKey: true,
          bubbles: true,
        }),
      );
      document.removeEventListener('keydown', pageShortcut);
      expect(pageShortcut).not.toHaveBeenCalled();
    });
  });

  describe('the system prompt', () => {
    it('unlocks with the method the device offers', async () => {
      const { unlockWithSystem } = await setup();
      unlockWithSystem.mockClear();
      await click(screen.getByRole('button', { name: 'Unlock with Face ID' }));
      expect(unlockWithSystem).toHaveBeenCalledOnce();
    });

    it('puts focus on Unlock when the cover opens', async () => {
      await setup();
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: 'Unlock with Face ID' }),
        ),
      );
    });

    it('offers the PIN instead, and the way back, moving focus with each', async () => {
      await setup();
      await click(screen.getByRole('button', { name: 'Use PIN instead' }));
      await vi.waitFor(() => expect(document.activeElement).toBe(pinField()));
      await click(screen.getByRole('button', { name: 'Use Face ID' }));
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: 'Unlock with Face ID' }),
        ),
      );
    });

    it('opens the prompt by itself once when a locked app starts', async () => {
      const { unlockWithSystem } = await setup();
      await vi.waitFor(() => expect(unlockWithSystem).toHaveBeenCalledOnce());
    });

    it('does not open it again after a cancel, until the app comes back to the front', async () => {
      const { unlockWithSystem, lifecycle, settle } = await setup();
      await vi.waitFor(() => expect(unlockWithSystem).toHaveBeenCalledOnce());
      lifecycle.next({ kind: 'active' });
      await settle();
      expect(unlockWithSystem).toHaveBeenCalledOnce();
      lifecycle.next({ kind: 'background' });
      lifecycle.next({ kind: 'active' });
      await settle();
      await vi.waitFor(() => expect(unlockWithSystem).toHaveBeenCalledTimes(2));
    });

    it('does not count the prompt’s own trip to the background as leaving', async () => {
      const { unlockWithSystem, lifecycle, systemUiActive, settle } =
        await setup();
      await vi.waitFor(() => expect(unlockWithSystem).toHaveBeenCalledOnce());
      systemUiActive.set(true);
      lifecycle.next({ kind: 'background' });
      systemUiActive.set(false);
      lifecycle.next({ kind: 'active' });
      await settle();
      expect(unlockWithSystem).toHaveBeenCalledOnce();
    });

    it('opens the prompt on desktop when the locked window gets focus again', async () => {
      const { unlockWithSystem, settle } = await setup({ desktop: true });
      await vi.waitFor(() => expect(unlockWithSystem).toHaveBeenCalledOnce());
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
      await settle();
      await vi.waitFor(() => expect(unlockWithSystem).toHaveBeenCalledTimes(2));
    });

    it('does not open the prompt when the person locks the app in front of them', async () => {
      const { unlockWithSystem, locked, settle } = await setup({
        locked: false,
      });
      locked.set(true);
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unlockWithSystem).not.toHaveBeenCalled();
      expect(
        screen.getByRole('button', { name: 'Unlock with Face ID' }),
      ).toBeTruthy();
    });

    it('falls back to the PIN when biometrics are locked out', async () => {
      const answers: UnlockOutcome[] = [
        { kind: 'cancelled' },
        { kind: 'use-pin', reason: 'locked-out' },
      ];
      const { unlockWithSystem } = await setup({
        system: () => of(answers.shift() ?? { kind: 'cancelled' }),
      });
      // The automatic prompt at start was cancelled; the button asks again.
      await vi.waitFor(() => expect(unlockWithSystem).toHaveBeenCalledOnce());
      await click(screen.getByRole('button', { name: 'Unlock with Face ID' }));
      expect(pinField()).toBeTruthy();
      await vi.waitFor(() => expect(document.activeElement).toBe(pinField()));
      expect(screen.getByTestId('app-lock-message').textContent).toContain(
        'Too many tries',
      );
      expect(screen.getByRole('status').textContent).toContain(
        'Too many tries',
      );
    });

    it('says why the PIN form took over, naming the method that went away', async () => {
      const { support, settle } = await setup({ desktop: true });
      support.set({
        system: { kind: 'unavailable', reason: 'not-configured' },
        pin: { kind: 'available', set: true, nextAttemptAt: null },
      });
      await settle();
      expect(pinField()).toBeTruthy();
      expect(screen.getByTestId('app-lock-message').textContent?.trim()).toBe(
        'Face ID isn’t available. Enter your Trinity PIN.',
      );
    });

    it('waits out the system prompt’s delay with the button disabled', async () => {
      await setup({ systemWaitUntil: Date.now() + 30_000 });
      const unlock = screen.getByRole('button', {
        name: 'Unlock with Face ID',
      }) as HTMLButtonElement;
      expect(unlock.disabled).toBe(true);
      expect(screen.getByTestId('app-lock-message').textContent).toContain(
        'Try again in 30 seconds',
      );
    });
  });

  describe('reading support again', () => {
    it('reads the host’s support when the cover opens', async () => {
      const { refreshSupport, locked, settle } = await setup({ locked: false });
      expect(refreshSupport).not.toHaveBeenCalled();
      locked.set(true);
      await settle();
      await vi.waitFor(() => expect(refreshSupport).toHaveBeenCalledOnce());
    });

    it('reads it again each time the locked app comes back', async () => {
      const { refreshSupport, lifecycle, settle } = await setup();
      await vi.waitFor(() => expect(refreshSupport).toHaveBeenCalled());
      const before = refreshSupport.mock.calls.length;
      lifecycle.next({ kind: 'background' });
      lifecycle.next({ kind: 'active' });
      await settle();
      expect(refreshSupport.mock.calls.length).toBeGreaterThan(before);
    });

    it('picks up a system prompt that became available', async () => {
      await setup({
        support: PIN_ONLY,
        refreshed: {
          system: { kind: 'available', biometry: 'touch-id' },
          pin: PIN_ONLY.pin,
        },
      });
      expect(
        await screen.findByRole('button', { name: 'Unlock with Touch ID' }),
      ).toBeTruthy();
    });
  });

  describe('the PIN form', () => {
    it('shows the PIN form alone where there is no system prompt', async () => {
      await setup({ support: PIN_ONLY });
      expect(pinField()).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: 'Use PIN instead' }),
      ).toBeNull();
      expect(screen.getByTestId('app-lock-message').textContent?.trim()).toBe(
        '',
      );
    });

    it('puts focus on the PIN field where the PIN is the only way', async () => {
      await setup({ support: PIN_ONLY });
      await vi.waitFor(() => expect(document.activeElement).toBe(pinField()));
    });

    it('is a numeric password field that the browser does not fill', async () => {
      await setup({ support: PIN_ONLY });
      const field = pinField();
      expect(field.getAttribute('type')).toBe('password');
      expect(field.getAttribute('inputmode')).toBe('numeric');
      expect(field.getAttribute('autocomplete')).toBe('off');
      expect(field.getAttribute('maxlength')).toBe('16');
    });

    it('unlocks with the PIN and keeps it nowhere on the page', async () => {
      const { unlockWithPin, container } = await setup({
        support: PIN_ONLY,
        pin: () => of<UnlockOutcome>({ kind: 'failed', until: null }),
      });
      await type(pinField(), FIXTURE_PIN);
      await click(screen.getByTestId('app-lock-pin-submit'));
      expect(unlockWithPin).toHaveBeenCalledWith(FIXTURE_PIN);
      expect(pinField().value === '').toBe(true);
      expect((container.textContent ?? '').includes(FIXTURE_PIN)).toBe(false);
    });

    it('announces a wrong PIN', async () => {
      await setup({
        support: PIN_ONLY,
        pin: () => of<UnlockOutcome>({ kind: 'failed', until: null }),
      });
      await type(pinField(), '000000');
      await click(screen.getByTestId('app-lock-pin-submit'));
      expect(screen.getByTestId('app-lock-message').textContent?.trim()).toBe(
        'That PIN isn’t right.',
      );
      expect(screen.getByRole('status').textContent?.trim()).toBe(
        'That PIN isn’t right.',
      );
    });

    it('says how long to wait after too many wrong PINs', async () => {
      const until = Date.now() + 5 * 60_000;
      await setup({
        support: PIN_ONLY,
        pin: () => of<UnlockOutcome>({ kind: 'delayed', until }),
      });
      await type(pinField(), '000000');
      await click(screen.getByTestId('app-lock-pin-submit'));
      expect(screen.getByTestId('app-lock-message').textContent).toContain(
        'Try again in 5 minutes',
      );
      expect(pinField().disabled).toBe(true);
    });

    it('keeps a wait the host reports after a reload', async () => {
      await setup({
        support: {
          ...PIN_ONLY,
          pin: {
            kind: 'available',
            set: true,
            nextAttemptAt: Date.now() + 60_000,
          },
        },
      });
      expect(screen.getByTestId('app-lock-message').textContent).toContain(
        'Try again in 1 minute',
      );
      expect(pinField().disabled).toBe(true);
    });

    it('refuses a malformed PIN before asking the host', async () => {
      const { unlockWithPin } = await setup({ support: PIN_ONLY });
      await type(pinField(), '12');
      await click(screen.getByTestId('app-lock-pin-submit'));
      expect(unlockWithPin).not.toHaveBeenCalled();
      expect(screen.getByText('Enter 4 to 16 digits.')).toBeTruthy();
      expect(pinField().getAttribute('aria-invalid')).toBe('true');
    });

    it('reads the PIN store again when the host cannot read it', async () => {
      const { refreshSupport } = await setup({
        support: PIN_ONLY,
        pin: () => of<UnlockOutcome>({ kind: 'unavailable' }),
      });
      refreshSupport.mockClear();
      await type(pinField(), '000000');
      await click(screen.getByTestId('app-lock-pin-submit'));
      expect(refreshSupport).toHaveBeenCalled();
      expect(screen.getByTestId('app-lock-message').textContent?.trim()).toBe(
        'Trinity can’t read your PIN right now. Try again.',
      );
    });
  });

  describe('waits', () => {
    it('shows no countdown for a delay that is already over, and does not retry', async () => {
      const now = Date.now();
      const { unlockWithPin } = await setup({
        support: PIN_ONLY,
        pin: () => of<UnlockOutcome>({ kind: 'delayed', until: now - 5_000 }),
      });
      await type(pinField(), '000000');
      await click(screen.getByTestId('app-lock-pin-submit'));
      const line = screen.getByTestId('app-lock-message').textContent ?? '';
      expect(line).not.toContain('Try again in');
      expect(line).not.toContain('-');
      expect(pinField().disabled).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(unlockWithPin).toHaveBeenCalledOnce();
    });

    it('shows no negative countdown when a failure’s wait has passed', async () => {
      await setup({
        support: PIN_ONLY,
        pin: () =>
          of<UnlockOutcome>({ kind: 'failed', until: Date.now() - 60_000 }),
      });
      await type(pinField(), '000000');
      await click(screen.getByTestId('app-lock-pin-submit'));
      expect(screen.getByTestId('app-lock-message').textContent?.trim()).toBe(
        'That PIN isn’t right.',
      );
      expect(pinField().disabled).toBe(false);
    });

    it('counts down, then lets the person try again without trying for them', async () => {
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
        ],
      });
      const { unlockWithPin, settle } = await setup({
        support: {
          ...PIN_ONLY,
          pin: {
            kind: 'available',
            set: true,
            nextAttemptAt: Date.now() + 30_000,
          },
        },
      });
      expect(screen.getByTestId('app-lock-message').textContent).toContain(
        'Try again in 30 seconds',
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(screen.getByTestId('app-lock-message').textContent).toContain(
        'Try again in 20 seconds',
      );
      expect(pinField().disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(21_000);
      await settle();
      expect(pinField().disabled).toBe(false);
      expect(screen.getByTestId('app-lock-message').textContent).not.toContain(
        'Try again in',
      );
      expect(screen.getByRole('status').textContent?.trim()).toBe(
        'You can try your PIN again.',
      );
      expect(unlockWithPin).not.toHaveBeenCalled();
    });

    it('announces the end of the system prompt’s delay', async () => {
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
        ],
      });
      const { systemWaitUntil, settle } = await setup({
        systemWaitUntil: Date.now() + 30_000,
      });
      await vi.advanceTimersByTimeAsync(30_000);
      // The service clears its own wait once the deadline passes.
      systemWaitUntil.set(null);
      await settle();
      const unlock = screen.getByRole('button', {
        name: 'Unlock with Face ID',
      }) as HTMLButtonElement;
      expect(unlock.disabled).toBe(false);
      expect(screen.getByRole('status').textContent?.trim()).toBe(
        'You can try again.',
      );
    });
  });

  describe('forgot PIN', () => {
    it('offers the erase only when no system prompt can unlock', async () => {
      const { resetInstallation, restart } = await setup({ support: PIN_ONLY });
      await click(screen.getByTestId('app-lock-forgot'));
      expect(
        screen.getByText(/the only way back into Trinity is to erase all data/),
      ).toBeTruthy();
      await click(screen.getByTestId('app-lock-erase'));
      expect(resetInstallation).toHaveBeenCalledOnce();
      expect(restart).toHaveBeenCalledOnce();
    });

    it('points to the system prompt when one can unlock', async () => {
      await setup();
      await click(screen.getByRole('button', { name: 'Use PIN instead' }));
      await click(screen.getByTestId('app-lock-forgot'));
      expect(
        screen.getByText(
          'Unlock with Face ID, then change your PIN in Settings › Security.',
        ),
      ).toBeTruthy();
      expect(screen.queryByTestId('app-lock-erase')).toBeNull();
    });

    it('goes back to the PIN form on Cancel', async () => {
      await setup({ support: PIN_ONLY });
      await click(screen.getByTestId('app-lock-forgot'));
      await click(screen.getByRole('button', { name: 'Cancel' }));
      expect(pinField()).toBeTruthy();
    });

    it('says why an erase failed and lets the person try again', async () => {
      const { restart, refreshSupport } = await setup({
        support: PIN_ONLY,
        reset: () =>
          of({
            kind: 'transition-in-progress' as const,
            operation: 'resetting-installation' as const,
          }),
      });
      await click(screen.getByTestId('app-lock-forgot'));
      refreshSupport.mockClear();
      await click(screen.getByTestId('app-lock-erase'));
      expect(restart).not.toHaveBeenCalled();
      expect(refreshSupport).toHaveBeenCalled();
      expect(screen.getByTestId('app-lock-message').textContent?.trim()).toBe(
        'Another account change is still in progress. Try again.',
      );
      expect(
        (screen.getByTestId('app-lock-erase') as HTMLButtonElement).disabled,
      ).toBe(false);
    });
  });

  describe('when the PIN can’t be read', () => {
    it('says so in the PIN form and offers Retry, the system prompt and the reset', async () => {
      const { retry, unlockWithSystem } = await setup({
        support: FACE_UNREADABLE_PIN,
      });
      await click(screen.getByRole('button', { name: 'Use PIN instead' }));
      expect(
        screen.getByText('Trinity can’t read your PIN right now.'),
      ).toBeTruthy();
      expect(screen.queryByLabelText('Trinity PIN')).toBeNull();
      await click(screen.getByRole('button', { name: 'Retry' }));
      expect(retry).toHaveBeenCalledOnce();
      await click(
        screen.getByRole('button', { name: 'Erase all data on this device' }),
      );
      expect(screen.getByTestId('app-lock-erase')).toBeTruthy();
      await click(screen.getByRole('button', { name: 'Cancel' }));
      unlockWithSystem.mockClear();
      await click(screen.getByRole('button', { name: 'Use Face ID' }));
      await click(screen.getByRole('button', { name: 'Unlock with Face ID' }));
      expect(unlockWithSystem).toHaveBeenCalledOnce();
    });

    it('names Trinity Next when it is the app running', async () => {
      await setup({ support: UNREADABLE_ONLY, appName: 'Trinity Next' });
      expect(
        screen.getByText('Trinity Next can’t read your PIN right now.'),
      ).toBeTruthy();
    });
  });

  describe('when only recovery is left', () => {
    it('offers Retry and the reset when the PIN store can’t be read', async () => {
      const { retry, unlockWithPin, unlockWithSystem, dialog } = await setup({
        support: UNREADABLE_ONLY,
      });
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(dialog.querySelector('input')).toBeNull();
      expect(
        screen.getAllByRole('button').map((b) => b.textContent?.trim()),
      ).toEqual(['Retry', 'Erase all data on this device']);
      await click(screen.getByRole('button', { name: 'Retry' }));
      expect(retry).toHaveBeenCalledOnce();
      expect(unlockWithPin).not.toHaveBeenCalled();
      expect(unlockWithSystem).not.toHaveBeenCalled();
    });

    it('offers only the reset when no PIN is stored', async () => {
      const { resetInstallation, restart, dialog } = await setup({
        support: NO_PIN_ONLY,
      });
      expect(dialog.querySelector('input')).toBeNull();
      expect(
        screen.getByText(
          'Trinity has no PIN on this device, so it can’t unlock. The only way back in is to erase all data on this device.',
        ),
      ).toBeTruthy();
      expect(
        screen.getAllByRole('button').map((b) => b.textContent?.trim()),
      ).toEqual(['Erase all data on this device']);
      await click(
        screen.getByRole('button', { name: 'Erase all data on this device' }),
      );
      await click(screen.getByTestId('app-lock-erase'));
      expect(resetInstallation).toHaveBeenCalledOnce();
      expect(restart).toHaveBeenCalledOnce();
    });

    it('offers only the reset where this device can’t keep a PIN', async () => {
      const { dialog } = await setup({
        support: NO_PIN_STORE_ONLY,
        appName: 'Trinity Next',
      });
      expect(dialog.querySelector('input')).toBeNull();
      expect(
        screen.getByText(
          'Trinity Next can’t check a PIN on this device, so it can’t unlock. The only way back in is to erase all data on this device.',
        ),
      ).toBeTruthy();
      expect(
        screen.getAllByRole('button').map((b) => b.textContent?.trim()),
      ).toEqual(['Erase all data on this device']);
    });
  });
});
