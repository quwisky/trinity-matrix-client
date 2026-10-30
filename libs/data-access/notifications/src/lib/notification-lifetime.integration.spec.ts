import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { lastValueFrom } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { setupLiveNotificationSettings } from '../contract/live-notification-settings';
import type { NotificationRuleHealth } from './notification-health.models';
import { NotificationLifetime } from './notification-lifetime';
import { RoomNotificationsService } from './room-notifications.service';

interface FaultableRoomNotifications {
  acknowledgeRules(): void;
  retryProjection(): void;
}

describe('NotificationLifetime with the real Room-rule projection', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('clears a retained reconciliation failure after the authoritative retry succeeds', async () => {
    setupLiveNotificationSettings();
    const lifetime = TestBed.inject(NotificationLifetime);
    const roomNotifications = TestBed.inject(
      RoomNotificationsService,
    ) as unknown as FaultableRoomNotifications;
    const facts: NotificationRuleHealth[] = [];
    const owner = lifetime.run(signal(true).asReadonly()).subscribe((event) => {
      if (event.kind === 'health') facts.push(event.fact);
    });
    expect(facts.at(-1)).toMatchObject({ condition: 'available' });
    const acknowledgeRules = roomNotifications.acknowledgeRules;
    roomNotifications.acknowledgeRules = () => {
      throw new Error('private response');
    };

    roomNotifications.retryProjection();
    await Promise.resolve();
    const failed = facts.at(-1)!;
    expect(failed).toMatchObject({
      condition: 'degraded',
      code: 'room-rules-reconciliation-failed',
    });

    roomNotifications.acknowledgeRules = acknowledgeRules;
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
