import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { TrnToastService } from '@trinity/components/overlay';
import {
  AppLockService,
  type AppLockStatus,
} from '@trinity/data-access/app-lock';
import {
  NativePushLifetime,
  NotificationService,
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
  Subject,
  filter,
  map,
  of,
  take,
  throwError,
  type Observable,
} from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityHealthService } from '../capability-health.service';
import { NotificationSessionService } from './notification-session.service';

interface FocusedConversation {
  readonly key: { readonly accountId: string; readonly roomId: string };
}

/** App lock's state, with `whenUnlocked` following it as the real service's does. */
function fakeAppLock(initial: AppLockStatus) {
  const status = signal(initial);
  const changes = new BehaviorSubject(initial);
  return {
    set(next: AppLockStatus): void {
      status.set(next);
      changes.next(next);
    },
    provider: MockProvider(AppLockService, {
      status: status.asReadonly() as never,
      whenUnlocked: () =>
        changes.pipe(
          filter((next) => next === 'off' || next === 'unlocked'),
          take(1),
          map(() => undefined),
        ),
    }),
  };
}

describe('NotificationSessionService', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  type LifecycleEvent = { readonly kind: 'active' | 'background' };

  function setup() {
    const focused = signal<FocusedConversation | null>(null);
    const lifecycle = new Subject<LifecycleEvent>();
    const clearRoom = vi.fn(
      (_userId: string, _roomId: string): Observable<void> => of(void 0),
    );
    const refreshBeforeBackground = vi.fn((): Observable<void> => of(void 0));
    TestBed.configureTestingModule({
      providers: [
        NotificationSessionService,
        MockProvider(NotificationService, { run: () => EMPTY }),
        MockProvider(NativePushLifetime, { run: () => EMPTY }),
        MockProvider(PushHandoffService, {
          run: () => EMPTY,
          clearRoom,
          refreshBeforeBackground,
        }),
        MockProvider(ConversationRuntime, {
          focused: focused.asReadonly() as never,
        }),
        MockProvider(HostLifecycleService, {
          events: lifecycle.asObservable(),
        }),
        MockProvider(WorkspaceNavigationService),
        MockProvider(CapabilityHealthService),
        MockProvider(TrnToastService),
        fakeAppLock('off').provider,
      ],
    });
    const open = (accountId: string, roomId: string): void => {
      focused.set({ key: { accountId, roomId } });
      TestBed.tick();
    };
    const lifetime = TestBed.inject(NotificationSessionService)
      .run()
      .subscribe();
    TestBed.tick();
    return {
      focused,
      lifecycle,
      clearRoom,
      refreshBeforeBackground,
      open,
      lifetime,
    };
  }

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
    function covered(initial: AppLockStatus = 'locked') {
      const appLock = fakeAppLock(initial);
      const notifications = new Subject<NotificationRuntimeEvent>();
      const pushes = new Subject<NativePushLifetimeEvent>();
      const lifecycle = new Subject<LifecycleEvent>();
      const focused = signal<FocusedConversation | null>(null);
      const navigate = vi.fn((_intent: unknown) =>
        of({ kind: 'ready' as const }),
      );
      const report = vi.fn();
      const clearRoom = vi.fn(
        (_userId: string, _roomId: string): Observable<void> => of(void 0),
      );
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
          MockProvider(PushHandoffService, {
            run: () => EMPTY,
            clearRoom,
            refreshBeforeBackground: () => of(void 0),
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
      const lifetime = TestBed.inject(NotificationSessionService)
        .run()
        .subscribe();
      TestBed.tick();
      const tap = (roomId: string): void =>
        notifications.next({
          kind: 'activated',
          destination: { accountId: '@me:hs', roomId, eventId: '$e' },
        });
      return {
        appLock,
        notifications,
        pushes,
        lifecycle,
        focused,
        navigate,
        report,
        clearRoom,
        bringForward,
        lifetime,
        tap,
      };
    }

    it('opens a tapped notification only once App lock is unlocked', () => {
      const { appLock, navigate, bringForward, lifetime, tap } = covered();

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
      lifetime.unsubscribe();
    });

    it('opens a tapped push notification only once App lock is unlocked', () => {
      const { appLock, pushes, navigate, lifetime } = covered();

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
      lifetime.unsubscribe();
    });

    it('waits until the lock state is known before opening a tap', () => {
      const { appLock, navigate, lifetime, tap } = covered('unknown');

      tap('!r:hs');
      expect(navigate).not.toHaveBeenCalled();

      appLock.set('off');
      expect(navigate).toHaveBeenCalledOnce();
      lifetime.unsubscribe();
    });

    it('opens only the latest notification tapped while locked', () => {
      const { appLock, navigate, lifetime, tap } = covered();

      tap('!a:hs');
      tap('!b:hs');
      appLock.set('unlocked');

      expect(navigate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ roomId: '!b:hs' }),
      );
      lifetime.unsubscribe();
    });

    it('keeps reporting notification health while a tap waits', () => {
      const { notifications, report, lifetime, tap } = covered();
      const fact = { context: Symbol('presentation'), generation: 1 };

      tap('!r:hs');
      notifications.next({ kind: 'health', fact } as never);

      expect(report).toHaveBeenCalledOnce();
      lifetime.unsubscribe();
    });

    it('keeps the open room’s notifications on a return to the lock screen, and clears them after unlock', () => {
      const { appLock, lifecycle, focused, clearRoom, lifetime } =
        covered('unlocked');
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
      lifetime.unsubscribe();
    });

    it('does not clear a room selected while locked until unlock', () => {
      const { appLock, focused, clearRoom, lifetime } = covered();
      focused.set({ key: { accountId: '@me:hs', roomId: '!b:hs' } });
      TestBed.tick();
      expect(clearRoom).not.toHaveBeenCalled();

      appLock.set('unlocked');
      TestBed.tick();
      expect(clearRoom).toHaveBeenCalledExactlyOnceWith('@me:hs', '!b:hs');
      lifetime.unsubscribe();
    });
  });
});
