import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { HostLifecycleService } from '@trinity/runtime/host';
import { MockProvider } from 'ng-mocks';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundSync } from './background-sync.service';

type LifecycleEvent = { readonly kind: 'active' | 'background' };

function setup(suspendedInBackground: boolean) {
  const events = new Subject<LifecycleEvent>();
  TestBed.configureTestingModule({
    providers: [
      MockProvider(HostLifecycleService, {
        events,
        suspendedInBackground,
      }),
      MockProvider(MatrixClientService),
    ],
  });
  const matrix = TestBed.inject(MatrixClientService);
  const subscription = TestBed.inject(BackgroundSync).run().subscribe();
  return { events, matrix, subscription };
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
