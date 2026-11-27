import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { PushService } from '@trinity/data-access/notifications';
import { signal } from '@angular/core';
import {
  BackgroundActivityService,
  HostLifecycleService,
} from '@trinity/runtime/host';
import { MockProvider } from 'ng-mocks';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundSync } from './background-sync.service';

type LifecycleEvent = { readonly kind: 'active' | 'background' };

function setup(suspendedInBackground: boolean, notifiesFromSync = false) {
  const inCall = signal(false);
  const events = new Subject<LifecycleEvent>();
  const notifiesFromBackgroundSync = signal(notifiesFromSync);
  TestBed.configureTestingModule({
    providers: [
      MockProvider(PushService, { notifiesFromBackgroundSync }),
      MockProvider(HostLifecycleService, {
        events,
        suspendedInBackground,
      }),
      MockProvider(BackgroundActivityService, { active: inCall }),
      MockProvider(MatrixClientService),
    ],
  });
  const matrix = TestBed.inject(MatrixClientService);
  const subscription = TestBed.inject(BackgroundSync).run().subscribe();
  return { events, matrix, subscription, notifiesFromBackgroundSync, inCall };
}

describe('BackgroundSync', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('stops sync in a phone background and restarts it in the foreground', () => {
    const { events, matrix, subscription } = setup(true);

    events.next({ kind: 'background' });
    expect(matrix.suspendSync).toHaveBeenCalledOnce();
    expect(matrix.resumeSync).not.toHaveBeenCalled();

    events.next({ kind: 'active' });
    expect(matrix.resumeSync).toHaveBeenCalledOnce();
    subscription.unsubscribe();
  });

  it('keeps syncing in the background while the app itself notifies from sync (Android without push)', () => {
    const { events, matrix, subscription, notifiesFromBackgroundSync } = setup(
      true,
      true,
    );

    events.next({ kind: 'background' });
    expect(matrix.suspendSync).not.toHaveBeenCalled();
    events.next({ kind: 'active' });

    notifiesFromBackgroundSync.set(false);
    events.next({ kind: 'background' });
    expect(matrix.suspendSync).toHaveBeenCalledOnce();
    subscription.unsubscribe();
  });

  it('keeps syncing in the background during a call and stops once it ends there', () => {
    const { events, matrix, subscription, inCall } = setup(true);

    inCall.set(true);
    events.next({ kind: 'background' });
    expect(matrix.suspendSync).not.toHaveBeenCalled();

    inCall.set(false);
    TestBed.tick();
    expect(matrix.suspendSync).toHaveBeenCalledOnce();
    subscription.unsubscribe();
  });

  it('does not stop sync when a call ends in the foreground', () => {
    const { events, matrix, subscription, inCall } = setup(true);

    inCall.set(true);
    events.next({ kind: 'background' });
    events.next({ kind: 'active' });
    inCall.set(false);
    TestBed.tick();
    expect(matrix.suspendSync).not.toHaveBeenCalled();
    subscription.unsubscribe();
  });

  it('follows rapid switches to the last one', () => {
    const { events, matrix, subscription } = setup(true);
    const calls: string[] = [];
    vi.mocked(matrix.suspendSync).mockImplementation(() => calls.push('stop'));
    vi.mocked(matrix.resumeSync).mockImplementation(() => calls.push('start'));

    for (const kind of ['background', 'active', 'background'] as const) {
      events.next({ kind });
    }

    expect(calls).toEqual(['stop', 'start', 'stop']);
    subscription.unsubscribe();
  });

  it('leaves sync running on hosts that keep the app running (web, desktop)', () => {
    const { events, matrix, subscription } = setup(false);

    events.next({ kind: 'background' });
    events.next({ kind: 'active' });

    expect(matrix.suspendSync).not.toHaveBeenCalled();
    expect(matrix.resumeSync).not.toHaveBeenCalled();
    expect(events.observed).toBe(false);
    subscription.unsubscribe();
  });
});
