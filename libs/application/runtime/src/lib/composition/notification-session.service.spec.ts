import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, lastValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NativePushLifetime,
  NotificationService,
  type NativePushLifetimeEvent,
  type NotificationRuntimeEvent,
} from '@trinity/data-access/notifications';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { TrnToastService } from '@trinity/components/overlay';
import { CapabilityHealthService } from '../capability-health.service';
import { NotificationSessionService } from './notification-session.service';

describe('NotificationSessionService', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(
    recoverPresentation = vi.fn(() => of({ kind: 'success' as const })),
  ) {
    const notifications = new Subject<NotificationRuntimeEvent>();
    const push = new Subject<NativePushLifetimeEvent>();
    const receivePush = vi.fn(() => of(undefined));
    const navigate = vi.fn(() =>
      of({ kind: 'ready', change: 'committed' } as const),
    );
    const show = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        NotificationSessionService,
        MockProvider(NotificationService, {
          run: () => notifications,
          recoverPresentation,
          receivePush,
        }),
        MockProvider(NativePushLifetime, { run: () => push }),
        MockProvider(WorkspaceNavigationService, { navigate }),
        MockProvider(TrnToastService, { show }),
        CapabilityHealthService,
      ],
    });

    return {
      service: TestBed.inject(NotificationSessionService),
      notifications,
      navigate,
      show,
      health: TestBed.inject(CapabilityHealthService),
      recoverPresentation,
      push,
      receivePush,
    };
  }

  it('forwards notification health and incidents without navigating', () => {
    const { service, notifications, navigate, show, health } = setup();
    const context = Symbol();
    const fact = {
      capability: 'notifications' as const,
      operation: 'presentation' as const,
      context,
      generation: 1,
      demanded: true,
      preparation: 'acknowledged' as const,
      ownership: 'retained' as const,
      condition: 'degraded' as const,
      code: 'notification-presentation-unavailable' as const,
    };

    const lifetime = service.run().subscribe();
    notifications.next({ kind: 'health', fact });
    notifications.next({
      kind: 'incident',
      incident: {
        context,
        capability: 'notifications',
        operation: 'presentation-command',
        code: 'notification-presentation-failed',
      },
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith('A notification could not be shown.', {
      duration: 4000,
    });
    expect(health.problems()).toHaveLength(1);
    expect(health.incidents()).toEqual([
      expect.objectContaining({
        capability: 'notifications',
        operation: 'presentation-command',
        code: 'notification-presentation-failed',
      }),
    ]);
    lifetime.unsubscribe();
  });

  it('forwards the recovery callback attached to notification health', async () => {
    const recover = vi.fn(() => of({ kind: 'success' as const }));
    const { service, notifications, health, recoverPresentation } =
      setup(recover);
    const context = Symbol();
    const fact = {
      capability: 'notifications' as const,
      operation: 'presentation' as const,
      context,
      generation: 2,
      demanded: true,
      preparation: 'acknowledged' as const,
      ownership: 'retained' as const,
      condition: 'degraded' as const,
      code: 'notification-presentation-unavailable' as const,
    };
    const lifetime = service.run().subscribe();

    notifications.next({ kind: 'health', fact });
    const problem = health.problems()[0]!;
    await expect(lastValueFrom(health.recover(problem))).resolves.toEqual({
      kind: 'success',
    });
    expect(recoverPresentation).toHaveBeenCalledWith(context, 2);
    lifetime.unsubscribe();
  });

  it('forwards a received push to notification delivery without navigating', () => {
    const { service, push, receivePush, navigate } = setup();
    const data = { room_id: '!room:example.org', event_id: '$event' };
    const lifetime = service.run().subscribe();

    push.next({ kind: 'received', data });

    expect(receivePush).toHaveBeenCalledWith(data);
    expect(navigate).not.toHaveBeenCalled();
    lifetime.unsubscribe();
  });
});
