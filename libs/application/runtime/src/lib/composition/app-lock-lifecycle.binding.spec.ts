import { signal, type Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TitleBarState } from '@trinity/application/workspace';
import { APP_LOCK_CLOCK, AppLockService } from '@trinity/data-access/app-lock';
import {
  KeyboardShortcutsService,
  MediaPickerService,
} from '@trinity/platform-native';
import {
  HOST_AUTHENTICATION_HANDOFF_OPERATION,
  HOST_FILE_EXPORT_OPERATION,
  HOST_USER_PRESENCE_OPERATION,
  HostAuthenticationHandoffService,
  HostFileExportService,
  HostLifecycleService,
  HostLockIntegrationService,
  HostSystemUiService,
  HostUserPresenceService,
  type HostAuthenticationHandoffOperation,
  type HostFileExportOperation,
  type HostLockRequest,
  type HostUserPresenceOperation,
} from '@trinity/runtime/host';
import { desktopBridgeFixture } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, Subject, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLockLifecycleBinding } from './app-lock-lifecycle.binding';

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
vi.mock('@capacitor/camera', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Camera: native.camera,
}));

type LifecycleEvent = { readonly kind: 'active' | 'background' };

function setup(
  options: {
    desktop?: boolean;
    lockAfter?: string;
    locked?: boolean;
    /** App lock turned on; it is unless a test says otherwise. */
    enabled?: boolean;
    /** The real system-UI count, for the producers that report to it. */
    systemUi?: 'mock' | 'real';
    providers?: Provider[];
  } = {},
) {
  if (options.desktop) {
    (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
      desktopBridgeFixture();
  }
  let now = 1_000_000;
  const enabled = options.enabled ?? true;
  const status = signal<'off' | 'locked' | 'unlocked'>(
    !enabled ? 'off' : options.locked ? 'locked' : 'unlocked',
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
  TestBed.configureTestingModule({
    providers: [
      AppLockLifecycleBinding,
      { provide: APP_LOCK_CLOCK, useValue: () => now },
      MockProvider(AppLockService, {
        status: status.asReadonly(),
        locked: locked.asReadonly(),
        enabled: signal(enabled).asReadonly(),
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
      MockProvider(KeyboardShortcutsService, { binding: () => null }),
      MockProvider(TitleBarState, { setLocked }),
      ...(options.providers ?? []),
    ],
  });
  const lifetime = TestBed.inject(AppLockLifecycleBinding).run().subscribe();
  TestBed.tick();
  return {
    lifecycle,
    requests,
    systemUiActive,
    status,
    locked,
    lockNow,
    setState,
    coverPainted,
    setLocked,
    lifetime,
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

describe('AppLockLifecycleBinding', () => {
  beforeEach(() =>
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
      ],
    }),
  );
  afterEach(() => {
    native.platform = false;
    for (const plugin of Object.values(native.camera)) plugin.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
    TestBed.resetTestingModule();
  });

  it('locks after the chosen time in the background', () => {
    const { lifecycle, lockNow, advance, lifetime } = setup();
    lifecycle.next({ kind: 'background' });
    advance(59_999);
    expect(lockNow).not.toHaveBeenCalled();
    advance(1);
    expect(lockNow).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('stays unlocked when the app comes back in time', () => {
    const { lifecycle, lockNow, advance, lifetime } = setup();
    lifecycle.next({ kind: 'background' });
    advance(30_000);
    lifecycle.next({ kind: 'active' });
    advance(60_000);
    expect(lockNow).not.toHaveBeenCalled();
    lifetime.unsubscribe();
  });

  it('locks on return when the delay passed while timers were frozen', () => {
    const { lifecycle, lockNow, skipClock, lifetime } = setup();
    lifecycle.next({ kind: 'background' });
    skipClock(61_000);
    lifecycle.next({ kind: 'active' });
    expect(lockNow).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('locks at once on mobile for Immediately', () => {
    const { lifecycle, lockNow, lifetime } = setup({
      lockAfter: 'immediately',
    });
    lifecycle.next({ kind: 'background' });
    expect(lockNow).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('gives a desktop window ten seconds after it loses focus', () => {
    const { lockNow, advance, lifetime } = setup({
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
    lifetime.unsubscribe();
  });

  it('counts from the first moment away when a blurred window is then minimised', () => {
    const { lifecycle, lockNow, advance, lifetime } = setup({ desktop: true });
    window.dispatchEvent(new Event('blur'));
    advance(30_000);
    lifecycle.next({ kind: 'background' });
    advance(30_000);
    expect(lockNow).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('does not start the away timer while Trinity’s own system UI is open', () => {
    const { lifecycle, systemUiActive, lockNow, advance, lifetime } = setup({
      lockAfter: 'immediately',
    });
    systemUiActive.set(true);
    lifecycle.next({ kind: 'background' });
    advance(120_000);
    lifecycle.next({ kind: 'active' });
    expect(lockNow).not.toHaveBeenCalled();
    lifetime.unsubscribe();
  });

  it('stops a running away timer when Trinity’s own system UI opens', () => {
    const { systemUiActive, lockNow, advance, lifetime } = setup({
      desktop: true,
    });
    window.dispatchEvent(new Event('blur'));
    advance(50_000);
    systemUiActive.set(true);
    TestBed.tick();
    advance(120_000);
    expect(lockNow).not.toHaveBeenCalled();
    lifetime.unsubscribe();
  });

  it('counts time away from when Trinity’s own system UI closes, if the app is still away', () => {
    const { systemUiActive, lockNow, advance, lifetime } = setup({
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
    lifetime.unsubscribe();
  });

  it('does not lock behind a system prompt that returns before the app reports it is back', () => {
    // Android's device-credential screen: the prompt answers, then the activity resumes.
    const { lifecycle, systemUiActive, lockNow, advance, lifetime } = setup({
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
    lifetime.unsubscribe();
  });

  it('still locks a mobile app left in the background after its own system UI closed', () => {
    const { lifecycle, systemUiActive, lockNow, skipClock, lifetime } = setup({
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
    lifetime.unsubscribe();
  });

  it('locks when the shell asks', () => {
    const { requests, lockNow, lifetime } = setup({ desktop: true });
    requests.next('system-locked');
    expect(lockNow).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('tells the shell the state and reveals a held window when nothing is locked', () => {
    const { lifecycle, setState, coverPainted, lifetime } = setup({
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
    lifetime.unsubscribe();
  });

  it('tells the shell nothing when a window that never left the screen gets focus back', () => {
    // The shell holds a window only while it is hidden or minimised; a focus change alone
    // has nothing for it to reveal.
    const { coverPainted, lifetime } = setup({ desktop: true });
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    expect(coverPainted).not.toHaveBeenCalled();
    lifetime.unsubscribe();
  });

  it('tells the shell nothing while App lock is off', () => {
    const { lifecycle, coverPainted, lifetime } = setup({
      desktop: true,
      enabled: false,
    });
    lifecycle.next({ kind: 'background' });
    lifecycle.next({ kind: 'active' });
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    expect(coverPainted).not.toHaveBeenCalled();
    lifetime.unsubscribe();
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
    const { lifecycle, coverPainted, lifetime } = setup({
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
    lifetime.unsubscribe();
  });

  it('treats a window that gets focus back as back on screen', () => {
    // A Windows restore of a maximised window may emit neither show nor restore.
    const { lifecycle, lockNow, advance, lifetime } = setup({ desktop: true });
    lifecycle.next({ kind: 'background' });
    window.dispatchEvent(new Event('blur'));
    advance(30_000);
    window.dispatchEvent(new Event('focus'));
    advance(120_000);
    expect(lockNow).not.toHaveBeenCalled();
    lifetime.unsubscribe();
  });

  it('keeps the window title neutral only while locked', () => {
    const { setLocked, locked, lifetime } = setup();
    expect(setLocked).toHaveBeenLastCalledWith(false);
    locked.set(true);
    TestBed.tick();
    expect(setLocked).toHaveBeenLastCalledWith(true);
    lifetime.unsubscribe();
  });

  describe('with Trinity’s own system UI open', () => {
    it('holds the away timer while the system prompt is open', () => {
      const answer = new Subject<never>();
      const presence = {
        verify: () => answer.asObservable(),
      } as Partial<HostUserPresenceOperation> as HostUserPresenceOperation;
      const { lifecycle, lockNow, advance, lifetime } = setup({
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
      lifetime.unsubscribe();
    });

    it('holds the away timer while a file export’s save or share sheet is open', () => {
      const exporter = {
        save: () => NEVER,
      } as Partial<HostFileExportOperation> as HostFileExportOperation;
      const { lifecycle, lockNow, advance, lifetime } = setup({
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
      lifetime.unsubscribe();
    });

    it('holds the away timer while the sign-in sheet is open', () => {
      const sheetClosed = new Subject<void>();
      const handoff = {
        open: () => of({ kind: 'completed' as const }),
        sheetClosed: sheetClosed.asObservable(),
      } as Partial<HostAuthenticationHandoffOperation> as HostAuthenticationHandoffOperation;
      const { lifecycle, lockNow, advance, lifetime } = setup({
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
      lifetime.unsubscribe();
    });

    it('runs the away timer again once the app is back from a sign-in sheet whose end was missed', () => {
      const handoff = {
        open: () => of({ kind: 'completed' as const }),
        sheetClosed: NEVER,
      } as Partial<HostAuthenticationHandoffOperation> as HostAuthenticationHandoffOperation;
      const { lifecycle, lockNow, advance, lifetime } = setup({
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
      lifetime.unsubscribe();
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
      const { lifecycle, lockNow, advance, lifetime } = setup({
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
      lifetime.unsubscribe();
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
      const { lifecycle, lockNow, advance, lifetime } = setup({
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
      lifetime.unsubscribe();
    });
  });
});
