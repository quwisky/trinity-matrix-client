import {
  ChangeDetectionStrategy,
  Component,
  signal,
  type Provider,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TitleBarState } from '@trinity/application/workspace';
import { APP_LOCK_CLOCK, AppLockService } from '@trinity/data-access/app-lock';
import {
  ExternalBrowserService,
  KeyboardShortcutsService,
  MediaPickerService,
  TrackFileChooserDirective,
} from '@trinity/platform-native';
import {
  HOST_AUTHENTICATION_HANDOFF_OPERATION,
  HOST_FILE_EXPORT_OPERATION,
  HOST_USER_PRESENCE_OPERATION,
  HostAuthenticationHandoffService,
  HostFileExportService,
  HostLifecycleService,
  HostLockIntegrationService,
  HostScreenPrivacyService,
  HostSystemUiService,
  HostUserPresenceService,
  type HostAuthenticationHandoffOperation,
  type HostFileExportOperation,
  type HostLockRequest,
  type HostOperationOutcome,
  type HostUserPresenceOperation,
} from '@trinity/runtime/host';
import { desktopBridgeFixture, TIMERS_AND_DATE } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import {
  NEVER,
  Subject,
  type Subscription,
  firstValueFrom,
  of,
  throwError,
  type Observable,
} from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLockLifecycleBinding } from './app-lock-lifecycle.binding';
import { HostSessionHealthService } from './host-session-health.service';

// The media picker runs for real; only the platform check and the camera plugin are replaced.
const native = vi.hoisted(() => ({
  platform: false,
  camera: {
    takePhoto: vi.fn(),
    recordVideo: vi.fn(),
    chooseFromGallery: vi.fn(),
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
  },
  browser: {
    open: vi.fn(() => Promise.resolve()),
    // The person never closes the sheet in these tests.
    addListener: vi.fn(() => new Promise(() => undefined)),
  },
}));
vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<{
    Capacitor: Record<string, unknown>;
  }>();
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, isNativePlatform: () => native.platform },
  };
});
vi.mock('@capacitor/browser', () => ({ Browser: native.browser }));
vi.mock('@capacitor/camera', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Camera: native.camera,
}));

@Component({
  imports: [TrackFileChooserDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<input type="file" hidden trnTrackFileChooser />`,
})
class FileInputHostComponent {}

/** A file input as the composer and Settings render it, opened the way they open it. */
function openFileChooser(): HTMLInputElement {
  const fixture = TestBed.createComponent(FileInputHostComponent);
  fixture.detectChanges();
  const input = (fixture.nativeElement as HTMLElement).querySelector(
    'input',
  ) as HTMLInputElement;
  input.click();
  TestBed.tick();
  return input;
}

type LifecycleEvent = { readonly kind: 'active' | 'background' };

let lifetime: Subscription | undefined;

function setup(
  options: {
    desktop?: boolean;
    lockAfter?: string;
    locked?: boolean;
    /** App lock turned on; it is unless a test says otherwise. */
    enabled?: boolean;
    /** The real system-UI count, for the producers that report to it. */
    systemUi?: 'mock' | 'real';
    /** What the app-switcher cover answers; it completes unless a test says otherwise. */
    privacySet?: () => Observable<HostOperationOutcome>;
    dismissPresented?: () => Observable<HostOperationOutcome>;
    providers?: Provider[];
  } = {},
) {
  if (options.desktop) {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture();
  }
  let now = 1_000_000;
  const enabled = signal(options.enabled ?? true);
  const status = signal<'off' | 'locked' | 'unlocked'>(
    !enabled() ? 'off' : options.locked ? 'locked' : 'unlocked',
  );
  const locked = signal(options.locked ?? false);
  const lifecycle = new Subject<LifecycleEvent>();
  const requests = new Subject<HostLockRequest>();
  const systemUiActive = signal(false);
  const lockNow = vi.fn(() => {
    status.set('locked');
    locked.set(true);
  });
  const setState = vi.fn(() => of({ kind: 'completed' as const }));
  const coverPainted = vi.fn(() => of({ kind: 'completed' as const }));
  const setLocked = vi.fn();
  const completed = () => of<HostOperationOutcome>({ kind: 'completed' });
  const privacySet = vi.fn<(on: boolean) => Observable<HostOperationOutcome>>(
    options.privacySet ?? completed,
  );
  const dismissPresented = vi.fn(options.dismissPresented ?? completed);
  const incident = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      AppLockLifecycleBinding,
      { provide: APP_LOCK_CLOCK, useValue: () => now },
      MockProvider(AppLockService, {
        status: status.asReadonly(),
        locked: locked.asReadonly(),
        enabled: enabled.asReadonly(),
        lockAfter: signal(options.lockAfter ?? '1m').asReadonly() as never,
        lockNow,
      }),
      MockProvider(HostLifecycleService, { events: lifecycle.asObservable() }),
      MockProvider(HostLockIntegrationService, {
        requests: requests.asObservable(),
        setState,
        coverPainted,
      }),
      options.systemUi === 'real'
        ? HostSystemUiService
        : MockProvider(HostSystemUiService, {
            active: systemUiActive.asReadonly(),
          }),
      MockProvider(HostScreenPrivacyService, {
        set: privacySet,
        dismissPresented,
      }),
      MockProvider(HostSessionHealthService, { incident }),
      MockProvider(KeyboardShortcutsService, { binding: () => null }),
      MockProvider(TitleBarState, { setLocked }),
      ...(options.providers ?? []),
    ],
  });
  lifetime = TestBed.inject(AppLockLifecycleBinding).run().subscribe();
  TestBed.tick();
  return {
    lifecycle,
    requests,
    systemUiActive,
    status,
    enabled,
    locked,
    lockNow,
    setState,
    privacySet,
    dismissPresented,
    incident,
    coverPainted,
    setLocked,
    /** Time passes and timers fire. */
    advance: (ms: number) => {
      now += ms;
      vi.advanceTimersByTime(ms);
    },
    /** Only the clock moves, as in a suspended web view. */
    skipClock: (ms: number) => {
      now += ms;
    },
  };
}

/** Subscribes to the cover's visits; the caller unsubscribes `visits` at the end. */
function recordVisits(label: (visit: string) => string = (visit) => visit) {
  const seen: string[] = [];
  const visits = TestBed.inject(AppLockLifecycleBinding).visits.subscribe(
    (visit) => seen.push(label(visit)),
  );
  return { seen, visits };
}

describe('AppLockLifecycleBinding', () => {
  beforeEach(() => vi.useFakeTimers(TIMERS_AND_DATE));
  afterEach(() => {
    lifetime?.unsubscribe();
    native.platform = false;
    for (const plugin of Object.values(native.camera)) plugin.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    TestBed.resetTestingModule();
  });

  it('locks after the chosen time in the background', () => {
    const { lifecycle, lockNow, advance } = setup();
    lifecycle.next({ kind: 'background' });
    advance(59_999);
    expect(lockNow).not.toHaveBeenCalled();
    advance(1);
    expect(lockNow).toHaveBeenCalledOnce();
  });

  it('stays unlocked when the app comes back in time', () => {
    const { lifecycle, lockNow, advance } = setup();
    lifecycle.next({ kind: 'background' });
    advance(30_000);
    lifecycle.next({ kind: 'active' });
    advance(60_000);
    expect(lockNow).not.toHaveBeenCalled();
  });

  it('locks on return when the delay passed while timers were frozen', () => {
    const { lifecycle, lockNow, skipClock } = setup();
    lifecycle.next({ kind: 'background' });
    skipClock(61_000);
    lifecycle.next({ kind: 'active' });
    expect(lockNow).toHaveBeenCalledOnce();
  });

  it('locks at once on mobile for Immediately', () => {
    const { lifecycle, lockNow } = setup({
      lockAfter: 'immediately',
    });
    lifecycle.next({ kind: 'background' });
    expect(lockNow).toHaveBeenCalledOnce();
  });

  it('gives a desktop window ten seconds after it loses focus', () => {
    const { lockNow, advance } = setup({
      desktop: true,
      lockAfter: 'immediately',
    });
    window.dispatchEvent(new Event('blur'));
    advance(9_999);
    expect(lockNow).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('focus'));
    advance(10_000);
    expect(lockNow).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('blur'));
    advance(10_000);
    expect(lockNow).toHaveBeenCalledOnce();
  });

  it('counts from the first moment away when a blurred window is then minimised', () => {
    const { lifecycle, lockNow, advance } = setup({ desktop: true });
    window.dispatchEvent(new Event('blur'));
    advance(30_000);
    lifecycle.next({ kind: 'background' });
    advance(30_000);
    expect(lockNow).toHaveBeenCalledOnce();
  });

  it('does not start the away timer while Trinity’s own system UI is open', () => {
    const { lifecycle, systemUiActive, lockNow, advance } = setup({
      lockAfter: 'immediately',
    });
    systemUiActive.set(true);
    lifecycle.next({ kind: 'background' });
    advance(120_000);
    lifecycle.next({ kind: 'active' });
    expect(lockNow).not.toHaveBeenCalled();
  });

  it('stops a running away timer when Trinity’s own system UI opens', () => {
    const { systemUiActive, lockNow, advance } = setup({
      desktop: true,
    });
    window.dispatchEvent(new Event('blur'));
    advance(50_000);
    systemUiActive.set(true);
    TestBed.tick();
    advance(120_000);
    expect(lockNow).not.toHaveBeenCalled();
  });

  it('counts time away from when Trinity’s own system UI closes, if the app is still away', () => {
    const { systemUiActive, lockNow, advance } = setup({
      desktop: true,
    });
    systemUiActive.set(true);
    TestBed.tick();
    window.dispatchEvent(new Event('blur'));
    advance(120_000);
    systemUiActive.set(false);
    TestBed.tick();
    advance(59_999);
    expect(lockNow).not.toHaveBeenCalled();
    advance(1);
    expect(lockNow).toHaveBeenCalledOnce();
  });

  it('does not lock behind a system prompt that returns before the app reports it is back', () => {
    // Android's device-credential screen: the prompt answers, then the activity resumes.
    const { lifecycle, systemUiActive, lockNow, advance } = setup({
      lockAfter: 'immediately',
    });
    systemUiActive.set(true);
    TestBed.tick();
    lifecycle.next({ kind: 'background' });
    advance(5_000);
    systemUiActive.set(false);
    TestBed.tick();
    advance(500);
    lifecycle.next({ kind: 'active' });
    advance(60_000);
    expect(lockNow).not.toHaveBeenCalled();
  });

  it('still locks a mobile app left in the background after its own system UI closed', () => {
    const { lifecycle, systemUiActive, lockNow, skipClock } = setup({
      lockAfter: 'immediately',
    });
    systemUiActive.set(true);
    TestBed.tick();
    lifecycle.next({ kind: 'background' });
    systemUiActive.set(false);
    TestBed.tick();
    skipClock(10_000);
    lifecycle.next({ kind: 'active' });
    expect(lockNow).toHaveBeenCalledOnce();
  });

  it('locks when the shell asks', () => {
    const { requests, lockNow } = setup({ desktop: true });
    requests.next('system-locked');
    expect(lockNow).toHaveBeenCalledOnce();
  });

  it('tells the shell the state and reveals a held window when nothing is locked', () => {
    const { lifecycle, setState, coverPainted } = setup({
      desktop: true,
    });
    expect(setState).toHaveBeenLastCalledWith({
      enabled: true,
      locked: false,
      accelerator: null,
    });
    lifecycle.next({ kind: 'background' });
    lifecycle.next({ kind: 'active' });
    expect(coverPainted).toHaveBeenCalledOnce();
    // The same return also brings focus back: the shell has already been told.
    window.dispatchEvent(new Event('focus'));
    expect(coverPainted).toHaveBeenCalledOnce();
  });

  it('gives the desktop menu the Lock Trinity chord once one is bound, and none after Reset', () => {
    const { setState } = setup({
      desktop: true,
      providers: [KeyboardShortcutsService],
    });
    const shortcuts = TestBed.inject(KeyboardShortcutsService);
    // Shipped unassigned: the menu item shows no accelerator.
    expect(setState).toHaveBeenLastCalledWith(
      expect.objectContaining({ accelerator: null }),
    );

    shortcuts.rebind('lock.now', {
      accel: true,
      alt: false,
      shift: true,
      key: 'l',
    });
    TestBed.tick();
    expect(setState).toHaveBeenLastCalledWith(
      expect.objectContaining({ accelerator: 'CommandOrControl+Shift+L' }),
    );

    shortcuts.reset('lock.now');
    TestBed.tick();
    expect(setState).toHaveBeenLastCalledWith(
      expect.objectContaining({ accelerator: null }),
    );
    shortcuts.resetAll();
  });

  it('tells the shell again when the window reports it is shown after an earlier focus', () => {
    // A restore whose DOM focus arrives before main has started the reveal: main ignores that
    // first signal, so the shown report must send it again rather than wait for the timeout.
    const { lifecycle, coverPainted } = setup({ desktop: true });
    lifecycle.next({ kind: 'background' });
    window.dispatchEvent(new Event('focus'));
    expect(coverPainted).toHaveBeenCalledOnce();
    lifecycle.next({ kind: 'active' });
    expect(coverPainted).toHaveBeenCalledTimes(2);
    // Once shown, focus changes have nothing more to reveal.
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    expect(coverPainted).toHaveBeenCalledTimes(2);
  });

  it('tells the cover the app came back only after locking what fell due on return', () => {
    const { lifecycle, locked, skipClock } = setup({
      lockAfter: '1m',
    });
    const { seen, visits } = recordVisits(
      (visit) => `${visit}:${locked() ? 'locked' : 'unlocked'}`,
    );
    lifecycle.next({ kind: 'background' });
    // Suspended in the background: no timer fired, so the lock falls due on return.
    skipClock(2 * 60_000);
    lifecycle.next({ kind: 'active' });
    expect(seen).toEqual(['away:unlocked', 'front:locked']);
    visits.unsubscribe();
  });

  it('tells the cover a locked window that reloads hidden is away until it shows', () => {
    // A crash reload in the tray: the host's one-time answer says hidden (#1343).
    const { lifecycle } = setup({ desktop: true, locked: true });
    const { seen, visits } = recordVisits();
    lifecycle.next({ kind: 'background' });
    expect(seen).toEqual(['away']);
    lifecycle.next({ kind: 'active' });
    expect(seen).toEqual(['away', 'front']);
    visits.unsubscribe();
  });

  it('counts desktop window focus and blur as visits', () => {
    setup({ desktop: true });
    const { seen, visits } = recordVisits();
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    expect(seen).toEqual(['away', 'front']);
    visits.unsubscribe();
  });

  it('does not count Trinity’s own system UI as a visit', () => {
    const { systemUiActive } = setup();
    const { seen, visits } = recordVisits();
    systemUiActive.set(true);
    TestBed.tick();
    systemUiActive.set(false);
    TestBed.tick();
    expect(seen).toEqual([]);
    visits.unsubscribe();
  });

  it('tells the shell nothing when a window that never left the screen gets focus back', () => {
    // The shell holds a window only while it is hidden or minimised; a focus change alone
    // has nothing for it to reveal.
    const { coverPainted } = setup({ desktop: true });
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    expect(coverPainted).not.toHaveBeenCalled();
  });

  it('tells the shell nothing while App lock is off', () => {
    const { lifecycle, coverPainted } = setup({
      desktop: true,
      enabled: false,
    });
    lifecycle.next({ kind: 'background' });
    lifecycle.next({ kind: 'active' });
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    expect(coverPainted).not.toHaveBeenCalled();
  });

  it('tells the shell again once the cover has painted when a locked window comes back', () => {
    let frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((frame) => {
      frames.push(frame);
      return frames.length;
    });
    const paintFrame = (time: number) => {
      const due = frames;
      frames = [];
      for (const frame of due) frame(time);
    };
    const { lifecycle, coverPainted } = setup({
      desktop: true,
      locked: true,
    });
    lifecycle.next({ kind: 'background' });
    lifecycle.next({ kind: 'active' });
    expect(coverPainted).not.toHaveBeenCalled();
    paintFrame(0);
    expect(coverPainted).not.toHaveBeenCalled();
    paintFrame(16);
    expect(coverPainted).toHaveBeenCalledOnce();
    // Focus moving away and back while locked on screen has nothing more to reveal.
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    paintFrame(32);
    paintFrame(48);
    expect(coverPainted).toHaveBeenCalledOnce();
  });

  it('treats a window that gets focus back as back on screen', () => {
    // A Windows restore of a maximised window may emit neither show nor restore.
    const { lifecycle, lockNow, advance } = setup({ desktop: true });
    lifecycle.next({ kind: 'background' });
    window.dispatchEvent(new Event('blur'));
    advance(30_000);
    window.dispatchEvent(new Event('focus'));
    advance(120_000);
    expect(lockNow).not.toHaveBeenCalled();
  });

  it('keeps the window title neutral only while locked', () => {
    const { setLocked, locked } = setup();
    expect(setLocked).toHaveBeenLastCalledWith(false);
    locked.set(true);
    TestBed.tick();
    expect(setLocked).toHaveBeenLastCalledWith(true);
  });

  describe('the app-switcher cover', () => {
    it('covers the app switcher whenever App lock is on, and takes down native UI on lock', () => {
      const { enabled, locked, privacySet, dismissPresented } = setup();
      expect(privacySet).toHaveBeenLastCalledWith(true);
      locked.set(true);
      TestBed.tick();
      expect(dismissPresented).toHaveBeenCalledOnce();
      enabled.set(false);
      TestBed.tick();
      expect(privacySet).toHaveBeenLastCalledWith(false);
    });

    it('leaves the cover off while App lock is off', () => {
      const { privacySet } = setup({ enabled: false });
      expect(privacySet).toHaveBeenCalledExactlyOnceWith(false);
    });

    it('takes down native UI each time the app locks, and never on unlock', () => {
      const { locked, dismissPresented } = setup();
      expect(dismissPresented).not.toHaveBeenCalled();
      locked.set(true);
      TestBed.tick();
      locked.set(false);
      TestBed.tick();
      expect(dismissPresented).toHaveBeenCalledOnce();
      locked.set(true);
      TestBed.tick();
      expect(dismissPresented).toHaveBeenCalledTimes(2);
    });

    it('turns the cover off even while turning it on has not answered', () => {
      const { enabled, privacySet } = setup({
        privacySet: () => NEVER,
      });
      enabled.set(false);
      TestBed.tick();
      expect(privacySet.mock.calls).toEqual([[true], [false]]);
    });

    it('asks once at a cold start that begins locked, while that call has not answered', () => {
      const { privacySet } = setup({
        locked: true,
        privacySet: () => NEVER,
      });
      expect(privacySet.mock.calls).toEqual([[true]]);
    });

    it('locks, unlocks and keeps covering when the cover fails', () => {
      const failed = () =>
        throwError(() => new Error('bridge gone with secret detail'));
      const {
        lifecycle,
        enabled,
        locked,
        status,
        lockNow,
        setLocked,
        privacySet,
        dismissPresented,
        incident,
      } = setup({
        lockAfter: 'immediately',
        privacySet: failed,
        dismissPresented: failed,
      });
      lifecycle.next({ kind: 'background' });
      TestBed.tick();
      expect(lockNow).toHaveBeenCalledOnce();
      expect(setLocked).toHaveBeenLastCalledWith(true);
      status.set('unlocked');
      locked.set(false);
      TestBed.tick();
      expect(setLocked).toHaveBeenLastCalledWith(false);
      locked.set(true);
      TestBed.tick();
      expect(dismissPresented).toHaveBeenCalledTimes(2);
      enabled.set(false);
      TestBed.tick();
      expect(privacySet).toHaveBeenLastCalledWith(false);
      // Each lock also tries the cover again. Stable codes only: nothing from the error
      // reaches diagnostics.
      expect(incident.mock.calls).toEqual([
        ['host', 'screen-privacy', 'screen-privacy-failed'],
        ['host', 'screen-privacy', 'screen-privacy-failed'],
        ['host', 'screen-privacy', 'dismiss-failed'],
        ['host', 'screen-privacy', 'screen-privacy-failed'],
        ['host', 'screen-privacy', 'dismiss-failed'],
        ['host', 'screen-privacy', 'screen-privacy-failed'],
      ]);
    });

    describe('when turning the cover on failed', () => {
      const REFUSED: HostOperationOutcome = {
        kind: 'rejected',
        diagnostic: { code: 'screen-privacy-failed' },
      };
      /** Refuses the first `failures` calls, then completes. */
      const refusing = (failures: number) => {
        let calls = 0;
        return () =>
          of<HostOperationOutcome>(
            (calls += 1) <= failures ? REFUSED : { kind: 'completed' },
          );
      };

      it('tries again at the next lock, and stops once the cover is on', () => {
        const { locked, privacySet } = setup({
          privacySet: refusing(1),
        });
        expect(privacySet.mock.calls).toEqual([[true]]);
        locked.set(true);
        TestBed.tick();
        expect(privacySet.mock.calls).toEqual([[true], [true]]);
        locked.set(false);
        TestBed.tick();
        locked.set(true);
        TestBed.tick();
        expect(privacySet).toHaveBeenCalledTimes(2);
      });

      it('tries again when the app comes back to the front', () => {
        const { lifecycle, privacySet } = setup({
          privacySet: refusing(2),
        });
        lifecycle.next({ kind: 'active' });
        expect(privacySet.mock.calls).toEqual([[true], [true]]);
        lifecycle.next({ kind: 'active' });
        expect(privacySet).toHaveBeenCalledTimes(3);
        lifecycle.next({ kind: 'active' });
        expect(privacySet).toHaveBeenCalledTimes(3);
      });

      it('tries again after a refusal at a cold start that begins locked', () => {
        const { lifecycle, locked, privacySet } = setup({
          locked: true,
          privacySet: refusing(2),
        });
        expect(privacySet.mock.calls).toEqual([[true]]);
        lifecycle.next({ kind: 'active' });
        expect(privacySet.mock.calls).toEqual([[true], [true]]);
        // Only the starting locked state is skipped: a later lock tries again too.
        locked.set(false);
        TestBed.tick();
        locked.set(true);
        TestBed.tick();
        expect(privacySet.mock.calls).toEqual([[true], [true], [true]]);
      });

      it('ends with the cover off when App lock is turned off during a retry', () => {
        const answers: Subject<HostOperationOutcome>[] = [];
        const { enabled, lifecycle, locked, privacySet } = setup({
          privacySet: () => {
            const answer = new Subject<HostOperationOutcome>();
            answers.push(answer);
            return answer;
          },
        });
        answers[0].next(REFUSED);
        locked.set(true);
        TestBed.tick();
        expect(privacySet.mock.calls).toEqual([[true], [true]]);
        enabled.set(false);
        TestBed.tick();
        expect(privacySet.mock.calls).toEqual([[true], [true], [false]]);
        // The dropped retry answers late; nothing follows it.
        answers[1].next({ kind: 'completed' });
        answers[2].next({ kind: 'completed' });
        lifecycle.next({ kind: 'active' });
        locked.set(false);
        TestBed.tick();
        locked.set(true);
        TestBed.tick();
        expect(privacySet).toHaveBeenLastCalledWith(false);
        expect(privacySet).toHaveBeenCalledTimes(3);
      });

      it('does not try again on a host without a cover', () => {
        const { lifecycle, locked, privacySet } = setup({
          privacySet: () =>
            of<HostOperationOutcome>({
              kind: 'unavailable',
              reason: 'not-supported',
            }),
        });
        lifecycle.next({ kind: 'active' });
        locked.set(true);
        TestBed.tick();
        expect(privacySet).toHaveBeenCalledOnce();
      });

      it('does not turn the cover on while App lock is off', () => {
        const { lifecycle, privacySet } = setup({
          enabled: false,
          privacySet: refusing(1),
        });
        lifecycle.next({ kind: 'active' });
        expect(privacySet.mock.calls).toEqual([[false]]);
      });
    });

    it('reports a refused cover or dismissal, but not a host without one', () => {
      const { locked, incident } = setup({
        privacySet: () =>
          of<HostOperationOutcome>({
            kind: 'unavailable',
            reason: 'not-supported',
          }),
        dismissPresented: () =>
          of<HostOperationOutcome>({
            kind: 'rejected',
            diagnostic: { code: 'dismiss-timeout' },
          }),
      });
      expect(incident).not.toHaveBeenCalled();
      locked.set(true);
      TestBed.tick();
      expect(incident).toHaveBeenCalledExactlyOnceWith(
        'host',
        'screen-privacy',
        'dismiss-timeout',
      );
    });
  });

  describe('with Trinity’s own system UI open', () => {
    it('holds the away timer while the system prompt is open', () => {
      const answer = new Subject<never>();
      const presence = {
        verify: () => answer.asObservable(),
      } as Partial<HostUserPresenceOperation> as HostUserPresenceOperation;
      const { lifecycle, lockNow, advance } = setup({
        lockAfter: 'immediately',
        systemUi: 'real',
        providers: [
          { provide: HOST_USER_PRESENCE_OPERATION, useValue: presence },
        ],
      });
      const prompt = TestBed.inject(HostUserPresenceService)
        .verify({ reason: 'Unlock Trinity' })
        .subscribe();
      lifecycle.next({ kind: 'background' });
      advance(120_000);
      lifecycle.next({ kind: 'active' });
      expect(lockNow).not.toHaveBeenCalled();
      prompt.unsubscribe();
    });

    it('holds the away timer while a file export’s save or share sheet is open', () => {
      const exporter = {
        save: () => NEVER,
      } as Partial<HostFileExportOperation> as HostFileExportOperation;
      const { lifecycle, lockNow, advance } = setup({
        lockAfter: 'immediately',
        systemUi: 'real',
        providers: [
          { provide: HOST_FILE_EXPORT_OPERATION, useValue: exporter },
        ],
      });
      const sheet = TestBed.inject(HostFileExportService)
        .save({ bytes: new Blob(['x']), filename: 'x.txt' })
        .subscribe();
      lifecycle.next({ kind: 'background' });
      advance(120_000);
      lifecycle.next({ kind: 'active' });
      expect(lockNow).not.toHaveBeenCalled();
      sheet.unsubscribe();
    });

    it('holds the away timer while a file chooser is open', () => {
      const { lockNow, advance } = setup({
        desktop: true,
        lockAfter: 'immediately',
        systemUi: 'real',
      });
      const input = openFileChooser();
      // The chooser takes focus from the window.
      window.dispatchEvent(new Event('blur'));
      advance(120_000);
      expect(lockNow).not.toHaveBeenCalled();
      // Cancelled while the person is still away: the time away counts from now.
      input.dispatchEvent(new Event('cancel'));
      TestBed.tick();
      advance(9_999);
      expect(lockNow).not.toHaveBeenCalled();
      advance(1);
      expect(lockNow).toHaveBeenCalledOnce();
    });

    it('runs the away timer again once the window has focus back after a file chooser whose end was missed', () => {
      const { lockNow, advance } = setup({
        desktop: true,
        lockAfter: 'immediately',
        systemUi: 'real',
      });
      openFileChooser();
      window.dispatchEvent(new Event('blur'));
      advance(120_000);
      // Neither change nor cancel arrives.
      window.dispatchEvent(new Event('focus'));
      TestBed.tick();
      expect(lockNow).not.toHaveBeenCalled();
      window.dispatchEvent(new Event('blur'));
      advance(10_000);
      expect(lockNow).toHaveBeenCalledOnce();
    });

    it('runs the away timer again once the app is back from a file chooser whose end was missed', () => {
      // Android's document picker sends Trinity to the background.
      const { lifecycle, lockNow, advance } = setup({
        lockAfter: 'immediately',
        systemUi: 'real',
      });
      openFileChooser();
      lifecycle.next({ kind: 'background' });
      advance(120_000);
      lifecycle.next({ kind: 'active' });
      TestBed.tick();
      expect(lockNow).not.toHaveBeenCalled();
      lifecycle.next({ kind: 'background' });
      expect(lockNow).toHaveBeenCalledOnce();
    });

    it('holds the away timer while the sign-in sheet is open', () => {
      const sheetClosed = new Subject<void>();
      const handoff = {
        open: () => of({ kind: 'completed' as const }),
        sheetClosed: sheetClosed.asObservable(),
      } as Partial<HostAuthenticationHandoffOperation> as HostAuthenticationHandoffOperation;
      const { lifecycle, lockNow, advance } = setup({
        lockAfter: 'immediately',
        systemUi: 'real',
        providers: [
          { provide: HOST_AUTHENTICATION_HANDOFF_OPERATION, useValue: handoff },
        ],
      });
      TestBed.inject(HostAuthenticationHandoffService)
        .open({ url: 'https://account.example/authorize' })
        .subscribe();
      TestBed.tick();
      // Custom Tabs sends the app to the background.
      lifecycle.next({ kind: 'background' });
      advance(120_000);
      expect(lockNow).not.toHaveBeenCalled();
      sheetClosed.next();
      TestBed.tick();
      lifecycle.next({ kind: 'active' });
      lifecycle.next({ kind: 'background' });
      expect(lockNow).toHaveBeenCalledOnce();
    });

    it('runs the away timer again once the app is back from a sign-in sheet whose end was missed', () => {
      const handoff = {
        open: () => of({ kind: 'completed' as const }),
        sheetClosed: NEVER,
      } as Partial<HostAuthenticationHandoffOperation> as HostAuthenticationHandoffOperation;
      const { lifecycle, lockNow, advance } = setup({
        lockAfter: 'immediately',
        systemUi: 'real',
        providers: [
          { provide: HOST_AUTHENTICATION_HANDOFF_OPERATION, useValue: handoff },
        ],
      });
      TestBed.inject(HostAuthenticationHandoffService)
        .open({ url: 'https://account.example/authorize' })
        .subscribe();
      TestBed.tick();
      lifecycle.next({ kind: 'background' });
      advance(120_000);
      // No callback, no close and no closed event: coming back releases the count.
      lifecycle.next({ kind: 'active' });
      TestBed.tick();
      expect(lockNow).not.toHaveBeenCalled();
      lifecycle.next({ kind: 'background' });
      expect(lockNow).toHaveBeenCalledOnce();
    });

    it('holds the away timer while an account page is open in the in-app browser', async () => {
      native.platform = true;
      const { lifecycle, lockNow, advance } = setup({
        lockAfter: 'immediately',
        systemUi: 'real',
      });
      await firstValueFrom(
        TestBed.inject(ExternalBrowserService).open(
          'https://account.example/account',
        ),
      );
      TestBed.tick();
      lifecycle.next({ kind: 'background' });
      advance(120_000);
      expect(lockNow).not.toHaveBeenCalled();
      // No closed event and no link: coming back releases the count.
      lifecycle.next({ kind: 'active' });
      TestBed.tick();
      expect(lockNow).not.toHaveBeenCalled();
      lifecycle.next({ kind: 'background' });
      expect(lockNow).toHaveBeenCalledOnce();
    });

    it('holds the away timer while the camera is open', async () => {
      native.platform = true;
      native.camera.checkPermissions.mockResolvedValue({
        camera: 'granted',
        photos: 'granted',
      });
      let cancel: (reason: unknown) => void = () => undefined;
      native.camera.takePhoto.mockReturnValue(
        new Promise((_, reject) => (cancel = reject)),
      );
      const { lifecycle, lockNow, advance } = setup({
        lockAfter: 'immediately',
        systemUi: 'real',
      });
      const photo = vi.fn();
      TestBed.inject(MediaPickerService)
        .capturePhoto({ saveToGallery: false })
        .subscribe(photo);
      await vi.advanceTimersByTimeAsync(0);
      expect(native.camera.takePhoto).toHaveBeenCalledOnce();
      lifecycle.next({ kind: 'background' });
      advance(120_000);
      lifecycle.next({ kind: 'active' });
      expect(lockNow).not.toHaveBeenCalled();
      // Closing the camera ends the count: the next time away locks at once again.
      cancel({ code: 'OS-PLUG-CAMR-0006' });
      await vi.advanceTimersByTimeAsync(0);
      expect(photo).toHaveBeenCalledWith(null);
      TestBed.tick();
      lifecycle.next({ kind: 'background' });
      expect(lockNow).toHaveBeenCalledOnce();
    });

    it('holds the away timer while the photo picker is open', async () => {
      native.platform = true;
      native.camera.checkPermissions.mockResolvedValue({
        camera: 'granted',
        photos: 'granted',
      });
      let choose: (value: { results: [] }) => void = () => undefined;
      native.camera.chooseFromGallery.mockReturnValue(
        new Promise((resolve) => (choose = resolve)),
      );
      const { lifecycle, lockNow, advance } = setup({
        lockAfter: 'immediately',
        systemUi: 'real',
      });
      TestBed.inject(MediaPickerService).pickImages().subscribe();
      await vi.advanceTimersByTimeAsync(0);
      expect(native.camera.chooseFromGallery).toHaveBeenCalledOnce();
      lifecycle.next({ kind: 'background' });
      advance(120_000);
      lifecycle.next({ kind: 'active' });
      expect(lockNow).not.toHaveBeenCalled();
      choose({ results: [] });
      await vi.advanceTimersByTimeAsync(0);
      TestBed.tick();
      lifecycle.next({ kind: 'background' });
      expect(lockNow).toHaveBeenCalledOnce();
    });
  });
});
