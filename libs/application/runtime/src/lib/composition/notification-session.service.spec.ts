import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { TrnToastService } from '@trinity/components/overlay';
import {
  NativePushLifetime,
  NotificationService,
  PushHandoffService,
} from '@trinity/data-access/notifications';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { HostLifecycleService } from '@trinity/runtime/host';
import { MockProvider } from 'ng-mocks';
import { EMPTY, Subject, of, type Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityHealthService } from '../capability-health.service';
import { NotificationSessionService } from './notification-session.service';

interface FocusedConversation {
  readonly key: { readonly accountId: string; readonly roomId: string };
}

describe('NotificationSessionService', () => {
  afterEach(() => TestBed.resetTestingModule());

  type LifecycleEvent = { readonly kind: 'active' | 'background' };

  function setup() {
    const focused = signal<FocusedConversation | null>(null);
    const lifecycle = new Subject<LifecycleEvent>();
    const clearRoom = vi.fn(
      (_userId: string, _roomId: string): Observable<void> => of(void 0),
    );
    TestBed.configureTestingModule({
      providers: [
        NotificationSessionService,
        MockProvider(NotificationService, { run: () => EMPTY }),
        MockProvider(NativePushLifetime, { run: () => EMPTY }),
        MockProvider(PushHandoffService, { run: () => EMPTY, clearRoom }),
        MockProvider(ConversationRuntime, {
          focused: focused.asReadonly() as never,
        }),
        MockProvider(HostLifecycleService, {
          events: lifecycle.asObservable(),
        }),
        MockProvider(WorkspaceNavigationService),
        MockProvider(CapabilityHealthService),
        MockProvider(TrnToastService),
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
    return { focused, lifecycle, clearRoom, open, lifetime };
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
});
