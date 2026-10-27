import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DiagnosticLogService } from '@trinity/data-access/diagnostic-log';
import {
  SessionStateService,
  type SessionSyncState,
} from '@trinity/data-access/matrix-client';
import { HostLifecycleService } from '@trinity/runtime/host';
import { MockProvider } from 'ng-mocks';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { DiagnosticMarkersBinding } from './diagnostic-markers.binding';

describe('DiagnosticMarkersBinding', () => {
  function setup() {
    const accountIds = signal<readonly string[]>([]);
    const syncState = signal<SessionSyncState | null>(null);
    const events = new Subject<{ kind: 'active' } | { kind: 'background' }>();
    const record = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        MockProvider(SessionStateService, { accountIds, syncState } as never),
        MockProvider(HostLifecycleService, { events } as never),
        MockProvider(DiagnosticLogService, { record }),
      ],
    });
    const subscription = TestBed.inject(DiagnosticMarkersBinding)
      .run()
      .subscribe();
    TestBed.tick();
    return { accountIds, syncState, events, record, subscription };
  }

  const messages = (record: ReturnType<typeof vi.fn>): string[] =>
    record.mock.calls.map(([entry]) => (entry as { message: string }).message);

  it('marks account count changes, sync state changes and foreground/background', () => {
    const { accountIds, syncState, events, record, subscription } = setup();

    accountIds.set(['@alice:example.org']);
    TestBed.tick();
    syncState.set('prepared');
    TestBed.tick();
    syncState.set('syncing');
    TestBed.tick();
    events.next({ kind: 'background' });
    events.next({ kind: 'active' });

    expect(messages(record)).toEqual([
      'accounts signed in: 0',
      'accounts signed in: 1',
      'sync state (active account): PREPARED',
      'sync state (active account): SYNCING',
      'app in background',
      'app in foreground',
    ]);
    expect(record.mock.calls[0][0]).toMatchObject({
      level: 'info',
      source: 'app',
      logger: 'lifecycle',
    });
    subscription.unsubscribe();
  });

  it('marks sync states in upper case and stays silent for null and starting', () => {
    const { syncState, record, subscription } = setup();

    syncState.set('starting');
    TestBed.tick();
    syncState.set('syncing');
    TestBed.tick();
    syncState.set('catchup');
    TestBed.tick();
    syncState.set(null);
    TestBed.tick();
    syncState.set('starting');
    TestBed.tick();

    expect(messages(record)).toEqual([
      'accounts signed in: 0',
      'sync state (active account): SYNCING',
      'sync state (active account): CATCHUP',
    ]);
    subscription.unsubscribe();
  });
});
