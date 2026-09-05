import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import type { MatrixClient } from 'matrix-js-sdk';
import { MockProvider, ngMocks } from 'ng-mocks';
import { lastValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRuleHealth } from './notification-health.models';
import { NotificationLifetime } from './notification-lifetime';
import { RoomNotificationsService } from './room-notifications.service';

interface FaultableRoomNotifications {
  rebindClients(): void;
  retryProjection(): void;
}

describe('NotificationLifetime with the real Room-rule projection', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('clears a retained reconciliation failure after the authoritative retry succeeds', async () => {
    const accountId = signal<string | null>('@a:example.org');
    const accountIds = signal<readonly string[]>(['@a:example.org']);
    const client = { on: vi.fn(), off: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        NotificationLifetime,
        RoomNotificationsService,
        ProjectionRuntime,
        MockProvider(MatrixClientService, {
          activeUserId: accountId.asReadonly(),
          accountIds: accountIds.asReadonly(),
        }),
      ],
    });
    const matrix = TestBed.inject(MatrixClientService);
    ngMocks.stubMember(matrix, 'isInitialized', true);
    ngMocks.stubMember(matrix, 'instance', client as unknown as MatrixClient);
    ngMocks.stubMember(matrix, 'all', () => [
      { client: client as unknown as MatrixClient } as never,
    ]);
    const lifetime = TestBed.inject(NotificationLifetime);
    const roomNotifications = TestBed.inject(
      RoomNotificationsService,
    ) as unknown as FaultableRoomNotifications;
    const facts: NotificationRuleHealth[] = [];
    const owner = lifetime.run(signal(true).asReadonly()).subscribe((event) => {
      if (event.kind === 'health') facts.push(event.fact);
    });
    const rebindClients = roomNotifications.rebindClients;
    roomNotifications.rebindClients = () => {
      throw new Error('private response');
    };

    roomNotifications.retryProjection();
    await Promise.resolve();
    const failed = facts.at(-1)!;
    expect(failed).toMatchObject({
      condition: 'degraded',
      code: 'room-rules-reconciliation-failed',
    });

    roomNotifications.rebindClients = rebindClients;
    await expect(
      lastValueFrom(lifetime.recover(failed.context, failed.generation)),
    ).resolves.toEqual({ kind: 'success' });
    expect(facts.at(-1)).toMatchObject({
      condition: 'available',
      code: 'room-rules-ready',
    });
    owner.unsubscribe();
  });
});
