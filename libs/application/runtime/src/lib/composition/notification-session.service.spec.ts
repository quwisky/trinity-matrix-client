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
import { MockProvider } from 'ng-mocks';
import { EMPTY, of, type Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityHealthService } from '../capability-health.service';
import { NotificationSessionService } from './notification-session.service';

interface FocusedConversation {
  readonly key: { readonly accountId: string; readonly roomId: string };
}

describe('NotificationSessionService', () => {
  afterEach(() => TestBed.resetTestingModule());

  it("clears a room's delivered notifications once each time it becomes the active room", () => {
    const focused = signal<FocusedConversation | null>(null);
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
});
