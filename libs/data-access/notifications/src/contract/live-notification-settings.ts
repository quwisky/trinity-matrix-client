import { TestBed } from '@angular/core/testing';
import { DestroyRef, signal } from '@angular/core';
import { NEVER } from 'rxjs';
import {
  EMPTY_SESSION,
  SESSION_ENGINE,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
} from '@trinity/data-access/matrix-client';
import { NOTIFICATION_ENGINE } from '../lib/notification-engine.token';
import { NotificationSettingsStore } from '../lib/notification-settings.store';
import { FakeNotificationEngine } from './fake-notification-engine';

function live(accountId: string): SessionAccountStatus {
  return {
    accountId,
    generation: 1,
    syncState: 'syncing',
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

/**
 * A running {@link NotificationSettingsStore} over a {@link FakeNotificationEngine}, with the
 * given accounts live (only the fake's `alice` has settings) and `active` the active account.
 */
export function setupLiveNotificationSettings(
  options: { active?: string | null; live?: readonly string[] } = {},
): { engine: FakeNotificationEngine; alice: string } {
  const engine = new FakeNotificationEngine();
  const alice = engine.alice;
  const active = options.active === undefined ? alice : options.active;
  const accounts = (options.live ?? (active ? [active] : [])).map(live);
  TestBed.configureTestingModule({
    providers: [
      { provide: NOTIFICATION_ENGINE, useValue: engine },
      {
        provide: SESSION_SNAPSHOT,
        useValue: signal({
          ...EMPTY_SESSION,
          activeAccountId: active,
          accounts,
        }),
      },
      { provide: SESSION_ENGINE, useValue: { session: () => NEVER } },
    ],
  });
  const running = TestBed.inject(NotificationSettingsStore).run().subscribe();
  TestBed.inject(DestroyRef).onDestroy(() => running.unsubscribe());
  return { engine, alice };
}
