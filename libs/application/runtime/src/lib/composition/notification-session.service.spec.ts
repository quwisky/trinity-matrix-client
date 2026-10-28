import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { TrnToastService } from '@trinity/components/overlay';
import {
  AppLockService,
  type AppLockStatus,
  type NotificationText,
} from '@trinity/data-access/app-lock';
import {
  NativePushLifetime,
  NotificationService,
  NotificationSettingsStore,
  PushHandoffService,
  type NativePushLifetimeEvent,
  type NotificationRuntimeEvent,
} from '@trinity/data-access/notifications';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { HostLifecycleService } from '@trinity/runtime/host';
import { MockProvider } from 'ng-mocks';
import {
  BehaviorSubject,
  EMPTY,
  Observable,
  Subject,
  type Subscription,
  filter,
  map,
  of,
  take,
  throwError,
} from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityHealthService } from '../capability-health.service';
import { NotificationSessionService } from './notification-session.service';

interface FocusedConversation {
  readonly key: { readonly accountId: string; readonly roomId: string };
}

/**
 * App lock's state, with `whenUnlocked` following it as the real service's does, and its
 * effective Notification text.
 */
function fakeAppLock(initial: AppLockStatus, text: NotificationText = 'show') {
  const status = signal(initial);
  const changes = new BehaviorSubject(initial);
  const mode = signal<NotificationText>(text);
  return {
    mode,
    set(next: AppLockStatus): void {
      status.set(next);
      changes.next(next);
    },
    provider: MockProvider(AppLockService, {
      status: status.asReadonly() as never,
      effectiveNotificationText: mode.asReadonly() as never,
      whenUnlocked: () =>
        changes.pipe(
          filter((next) => next === 'off' || next === 'unlocked'),
          take(1),
          map(() => undefined),
        ),
    }),
  };
}

let lifetime: Subscription | undefined;

describe('NotificationSessionService', () => {
  afterEach(() => {
    lifetime?.unsubscribe();
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  type LifecycleEvent = { readonly kind: 'active' | 'background' };

  function setup(
    options: {
      status?: AppLockStatus;
      text?: NotificationText;
      writeNotificationText?: (mode: NotificationText) => Observable<void>;
      notificationTextLost?: Observable<void>;
      beforeRun?: (
        lifecycle: Subject<LifecycleEvent>,
        appLock: ReturnType<typeof fakeAppLock>,
      ) => void;
    } = {},
  ) {
    const appLock = fakeAppLock(options.status ?? 'off', options.text);
    const notifications = new Subject<NotificationRuntimeEvent>();
    const pushes = new Subject<NativePushLifetimeEvent>();
    const lifecycle = new Subject<LifecycleEvent>();
    options.beforeRun?.(lifecycle, appLock);
    const writeNotificationText = vi.fn(
      options.writeNotificationText ??
        ((_mode: NotificationText): Observable<void> => of(void 0)),
    );
    const clearDelivered = vi.fn((): Observable<void> => of(void 0));
    const focused = signal<FocusedConversation | null>(null);
    const navigate = vi.fn((_intent: unknown) =>
      of({ kind: 'ready' as const }),
    );
    const report = vi.fn();
    const clearRoom = vi.fn(
      (_userId: string, _roomId: string): Observable<void> => of(void 0),
    );
    const refreshBeforeBackground = vi.fn((): Observable<void> => of(void 0));
    let settingsHeld = 0;
    const settingsLifetime = new Observable<never>(() => {
      settingsHeld += 1;
      return () => (settingsHeld -= 1);
    });
    const bringForward = vi
      .spyOn(window, 'focus')
      .mockImplementation(() => undefined);
    TestBed.configureTestingModule({
      providers: [
        NotificationSessionService,
        MockProvider(NotificationService, {
          run: () => notifications as never,
        }),
        MockProvider(NativePushLifetime, { run: () => pushes as never }),
        MockProvider(NotificationSettingsStore, {
          run: () => settingsLifetime,
        }),
        MockProvider(PushHandoffService, {
          run: () => EMPTY,
          clearRoom,
          refreshBeforeBackground,
          writeNotificationText,
          clearDelivered,
          notificationTextLost: options.notificationTextLost ?? EMPTY,
        }),
        MockProvider(ConversationRuntime, {
          focused: focused.asReadonly() as never,
        }),
        MockProvider(HostLifecycleService, {
          events: lifecycle.asObservable(),
        }),
        MockProvider(WorkspaceNavigationService, {
          navigate: navigate as never,
        }),
        MockProvider(CapabilityHealthService, { report }),
        MockProvider(TrnToastService),
        appLock.provider,
      ],
    });
    const open = (accountId: string, roomId: string): void => {
      focused.set({ key: { accountId, roomId } });
      TestBed.tick();
    };
    lifetime = TestBed.inject(NotificationSessionService).run().subscribe();
    TestBed.tick();
    const tap = (roomId: string): void =>
      notifications.next({
        kind: 'activated',
        destination: { accountId: '@me:hs', roomId, eventId: '$e' },
      });
    return {
      focused,
      lifecycle,
      clearRoom,
      refreshBeforeBackground,
      open,
      lifetime,
      appLock,
      writeNotificationText,
      clearDelivered,
      notifications,
      pushes,
      navigate,
      report,
      bringForward,
      tap,
      settingsHeld: () => settingsHeld,
    };
  }

  it('keeps the notification settings warm for the whole session', () => {
    const { settingsHeld, lifetime } = setup();
    expect(settingsHeld()).toBe(1);

    lifetime.unsubscribe();

    expect(settingsHeld()).toBe(0);
  });

  describe('the notification text mirror', () => {
    it('mirrors the notification text and clears notifications only when it gets more private', () => {
      const { appLock, writeNotificationText, clearDelivered } = setup({
        text: 'show',
      });
      expect(writeNotificationText).toHaveBeenCalledOnce();
      expect(writeNotificationText).toHaveBeenLastCalledWith('show');
      expect(clearDelivered).not.toHaveBeenCalled();

      appLock.mode.set('hide-on-lock-screen');
      TestBed.tick();
      expect(writeNotificationText).toHaveBeenLastCalledWith(
        'hide-on-lock-screen',
      );
      expect(clearDelivered).toHaveBeenCalledOnce();

      appLock.mode.set('always-hide');
      TestBed.tick();
      expect(writeNotificationText).toHaveBeenLastCalledWith('always-hide');
      expect(clearDelivered).toHaveBeenCalledTimes(2);
      expect(writeNotificationText.mock.invocationCallOrder[2]).toBeLessThan(
        clearDelivered.mock.invocationCallOrder[1],
      );

      appLock.mode.set('show');
      TestBed.tick();
      expect(writeNotificationText).toHaveBeenLastCalledWith('show');
      expect(clearDelivered).toHaveBeenCalledTimes(2);
    });

    it('writes nothing until App lock has loaded, then the loaded mode', () => {
      const { appLock, writeNotificationText } = setup({
        status: 'unknown',
        text: 'always-hide',
      });
      expect(writeNotificationText).not.toHaveBeenCalled();

      appLock.mode.set('hide-on-lock-screen');
      appLock.set('locked');
      TestBed.tick();
      expect(writeNotificationText).toHaveBeenCalledOnce();
      expect(writeNotificationText).toHaveBeenLastCalledWith(
        'hide-on-lock-screen',
      );
    });

    it('writes nothing again for the same mode, and nothing after the session ends', () => {
      const { appLock, writeNotificationText, lifetime } = setup();
      appLock.set('locked');
      TestBed.tick();
      appLock.set('unlocked');
      TestBed.tick();
      expect(writeNotificationText).toHaveBeenCalledOnce();

      lifetime.unsubscribe();
      appLock.mode.set('always-hide');
      TestBed.tick();
      expect(writeNotificationText).toHaveBeenCalledOnce();
    });

    it('writes a refused mode again when App lock reports in again', async () => {
      let refuse = true;
      const { appLock, writeNotificationText } = setup({
        writeNotificationText: () =>
          refuse ? throwError(() => new Error('refused')) : of(void 0),
      });
      expect(writeNotificationText).toHaveBeenCalledOnce();
      refuse = false;
      await Promise.resolve();

      appLock.set('locked');
      TestBed.tick();
      expect(writeNotificationText).toHaveBeenCalledTimes(2);
      expect(writeNotificationText).toHaveBeenLastCalledWith('show');

      appLock.set('unlocked');
      TestBed.tick();
      expect(writeNotificationText).toHaveBeenCalledTimes(2);
    });

    it('writes the mode again after the store lost it', () => {
      const lost = new Subject<void>();
      const { appLock, writeNotificationText } = setup({
        notificationTextLost: lost,
      });
      expect(writeNotificationText).toHaveBeenCalledOnce();
      lost.next();

      appLock.set('locked');
      TestBed.tick();
      expect(writeNotificationText).toHaveBeenCalledTimes(2);
      expect(writeNotificationText).toHaveBeenLastCalledWith('show');
    });

    it('still clears on a more private change after an earlier write was refused', async () => {
      let refuse = true;
      const { appLock, writeNotificationText, clearDelivered } = setup({
        writeNotificationText: () =>
          refuse ? throwError(() => new Error('refused')) : of(void 0),
      });
      refuse = false;
      await Promise.resolve();

      appLock.mode.set('always-hide');
      TestBed.tick();
      expect(writeNotificationText).toHaveBeenLastCalledWith('always-hide');
      expect(clearDelivered).toHaveBeenCalledOnce();
    });

    it('still clears delivered notifications, and keeps mirroring, after a write fails', () => {
      let fail = false;
      const { appLock, writeNotificationText, clearDelivered } = setup({
        writeNotificationText: () =>
          fail ? throwError(() => new Error('refused')) : of(void 0),
      });
      fail = true;
      appLock.mode.set('always-hide');
      TestBed.tick();
      expect(writeNotificationText).toHaveBeenLastCalledWith('always-hide');
      expect(clearDelivered).toHaveBeenCalledOnce();

      fail = false;
      appLock.mode.set('show');
      TestBed.tick();
      expect(writeNotificationText).toHaveBeenLastCalledWith('show');
      expect(writeNotificationText).toHaveBeenCalledTimes(3);
    });
  });

  it("clears a room's delivered notifications once each time it becomes the active room", () => {
    const { focused, clearRoom, open, lifetime } = setup();
    expect(clearRoom).not.toHaveBeenCalled();

    open('@me:hs', '!a:hs');
    // Workspace re-focusing the same room is not a new activation.
    open('@me:hs', '!a:hs');
    open('@me:hs', '!b:hs');
    focused.set(null);
    TestBed.tick();
    open('@me:hs', '!a:hs');

    expect(clearRoom.mock.calls).toEqual([
      ['@me:hs', '!a:hs'],
      ['@me:hs', '!b:hs'],
      ['@me:hs', '!a:hs'],
    ]);

    lifetime.unsubscribe();
    open('@me:hs', '!c:hs');
    expect(clearRoom).toHaveBeenCalledTimes(3);
  });

  it('clears the open room again when the app returns to the foreground', () => {
    const { lifecycle, clearRoom, open, lifetime } = setup();
    open('@me:hs', '!a:hs');
    clearRoom.mockClear();

    // Pushes for the open room arrived as native notifications while the app was hidden.
    lifecycle.next({ kind: 'background' });
    expect(clearRoom).not.toHaveBeenCalled();
    lifecycle.next({ kind: 'active' });
    expect(clearRoom.mock.calls).toEqual([['@me:hs', '!a:hs']]);

    lifetime.unsubscribe();
    lifecycle.next({ kind: 'background' });
    lifecycle.next({ kind: 'active' });
    expect(clearRoom).toHaveBeenCalledOnce();
  });

  it('clears nothing on return to the foreground when no room is open', () => {
    const { lifecycle, clearRoom } = setup();

    lifecycle.next({ kind: 'background' });
    lifecycle.next({ kind: 'active' });

    expect(clearRoom).not.toHaveBeenCalled();
  });

  it('refreshes tokens for the push handoff each time the app goes to the background', () => {
    const { lifecycle, refreshBeforeBackground, lifetime } = setup();

    lifecycle.next({ kind: 'background' });
    lifecycle.next({ kind: 'active' });
    lifecycle.next({ kind: 'background' });
    expect(refreshBeforeBackground).toHaveBeenCalledTimes(2);

    lifetime.unsubscribe();
    lifecycle.next({ kind: 'background' });
    expect(refreshBeforeBackground).toHaveBeenCalledTimes(2);
  });

  it('does not start a second refresh while the first is still running', () => {
    const { lifecycle, refreshBeforeBackground } = setup();
    const pending = new Subject<void>();
    refreshBeforeBackground.mockReturnValueOnce(pending);

    lifecycle.next({ kind: 'background' });
    lifecycle.next({ kind: 'active' });
    lifecycle.next({ kind: 'background' });
    expect(refreshBeforeBackground).toHaveBeenCalledOnce();

    pending.complete();
    lifecycle.next({ kind: 'background' });
    expect(refreshBeforeBackground).toHaveBeenCalledTimes(2);
  });

  it('keeps refreshing and clearing after a refresh fails', () => {
    const { lifecycle, refreshBeforeBackground, clearRoom, open } = setup();
    open('@me:hs', '!a:hs');
    clearRoom.mockClear();
    refreshBeforeBackground.mockReturnValueOnce(
      throwError(() => new Error('offline')),
    );

    lifecycle.next({ kind: 'background' });
    lifecycle.next({ kind: 'active' });
    lifecycle.next({ kind: 'background' });

    expect(refreshBeforeBackground).toHaveBeenCalledTimes(2);
    expect(clearRoom.mock.calls).toEqual([['@me:hs', '!a:hs']]);
  });
  describe('while App lock covers the app', () => {
    it('opens a tapped notification only once App lock is unlocked', () => {
      const { appLock, navigate, bringForward, tap } = setup({
        status: 'locked',
      });

      tap('!r:hs');
      expect(bringForward).toHaveBeenCalledOnce(); // forward, to the lock screen
      expect(navigate).not.toHaveBeenCalled();

      appLock.set('unlocked');
      expect(navigate).toHaveBeenCalledExactlyOnceWith({
        kind: 'notification',
        accountId: '@me:hs',
        roomId: '!r:hs',
        eventId: '$e',
      });
    });

    it('opens a tapped push notification only once App lock is unlocked', () => {
      const { appLock, pushes, navigate } = setup({
        status: 'locked',
      });

      pushes.next({
        kind: 'activated',
        destination: { accountId: '@me:hs', roomId: '!r:hs', eventId: '$e' },
      });
      expect(navigate).not.toHaveBeenCalled();

      appLock.set('unlocked');
      expect(navigate).toHaveBeenCalledExactlyOnceWith({
        kind: 'notification',
        accountId: '@me:hs',
        roomId: '!r:hs',
        eventId: '$e',
      });
    });

    it('waits until the lock state is known before opening a tap', () => {
      const { appLock, navigate, tap } = setup({ status: 'unknown' });

      tap('!r:hs');
      expect(navigate).not.toHaveBeenCalled();

      appLock.set('off');
      expect(navigate).toHaveBeenCalledOnce();
    });

    it('opens only the latest notification tapped while locked', () => {
      const { appLock, navigate, tap } = setup({ status: 'locked' });

      tap('!a:hs');
      tap('!b:hs');
      appLock.set('unlocked');

      expect(navigate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ roomId: '!b:hs' }),
      );
    });

    it('keeps reporting notification health while a tap waits', () => {
      const { notifications, report, tap } = setup({
        status: 'locked',
      });
      const fact = { context: Symbol('presentation'), generation: 1 };

      tap('!r:hs');
      notifications.next({ kind: 'health', fact } as never);

      expect(report).toHaveBeenCalledOnce();
    });

    it('keeps the open room’s notifications on a return to the lock screen, and clears them after unlock', () => {
      const { appLock, lifecycle, focused, clearRoom } = setup({
        status: 'unlocked',
      });
      focused.set({ key: { accountId: '@me:hs', roomId: '!r:hs' } });
      TestBed.tick();
      expect(clearRoom).toHaveBeenCalledOnce();

      appLock.set('locked');
      TestBed.tick();
      lifecycle.next({ kind: 'active' }); // back to the lock screen
      TestBed.tick();
      expect(clearRoom).toHaveBeenCalledOnce();

      appLock.set('unlocked');
      TestBed.tick();
      expect(clearRoom).toHaveBeenCalledTimes(2);
      expect(clearRoom).toHaveBeenLastCalledWith('@me:hs', '!r:hs');
    });

    // The away timer locks on the same `active` event; which of the two hears it first is
    // up to subscription order, so the session must not depend on it.
    it.each(['before', 'after'] as const)(
      'keeps the open room’s notifications when the return itself locks (away timer subscribed %s)',
      async (order) => {
        const awayTimer = (
          lifecycle: Subject<LifecycleEvent>,
          appLock: ReturnType<typeof fakeAppLock>,
        ) =>
          lifecycle.subscribe((event) => {
            if (event.kind === 'active') appLock.set('locked');
          });
        let away: Subscription | undefined;
        const { appLock, lifecycle, focused, clearRoom } = setup({
          status: 'unlocked',
          beforeRun:
            order === 'before'
              ? (events, lock) => (away = awayTimer(events, lock))
              : undefined,
        });
        if (order === 'after') away = awayTimer(lifecycle, appLock);
        focused.set({ key: { accountId: '@me:hs', roomId: '!r:hs' } });
        TestBed.tick();
        expect(clearRoom).toHaveBeenCalledOnce();

        lifecycle.next({ kind: 'active' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        TestBed.tick();
        expect(clearRoom).toHaveBeenCalledOnce();

        appLock.set('unlocked');
        TestBed.tick();
        expect(clearRoom).toHaveBeenCalledTimes(2);
        away?.unsubscribe();
      },
    );

    it('clears the open room on a return that does not lock, once the event is over', async () => {
      const { lifecycle, focused, clearRoom } = setup({
        status: 'unlocked',
      });
      focused.set({ key: { accountId: '@me:hs', roomId: '!r:hs' } });
      TestBed.tick();
      clearRoom.mockClear();

      lifecycle.next({ kind: 'active' });
      await vi.waitFor(() =>
        expect(clearRoom).toHaveBeenCalledExactlyOnceWith('@me:hs', '!r:hs'),
      );
    });

    it('does not clear a room selected while locked until unlock', () => {
      const { appLock, focused, clearRoom } = setup({
        status: 'locked',
      });
      focused.set({ key: { accountId: '@me:hs', roomId: '!b:hs' } });
      TestBed.tick();
      expect(clearRoom).not.toHaveBeenCalled();

      appLock.set('unlocked');
      TestBed.tick();
      expect(clearRoom).toHaveBeenCalledExactlyOnceWith('@me:hs', '!b:hs');
    });
  });
});
