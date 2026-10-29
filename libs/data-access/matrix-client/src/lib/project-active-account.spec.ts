import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import { projectActiveAccount } from './project-active-account';
import type { ProjectActiveAccountConfig } from './project-active-account';
import {
  EMPTY_SESSION,
  type SessionAccountStatus,
  type SessionSnapshot,
} from './session-engine';
import { SESSION_SNAPSHOT } from './session-engine.token';

const ID = 'test.active-account';

function status(accountId: string, generation = 1): SessionAccountStatus {
  return {
    accountId,
    generation,
    syncState: 'syncing',
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

function live(accountId: string, generation = 1): SessionSnapshot {
  return {
    activeAccountId: accountId,
    accounts: [status(accountId, generation)],
    softLoggedOut: [],
  };
}

/** Each account's source is a BehaviorSubject unless `sources` replaces it. */
function harness(
  over: Partial<ProjectActiveAccountConfig<string>> = {},
  initial: SessionSnapshot = live('@a:hs'),
) {
  const snapshot = signal(initial);
  TestBed.configureTestingModule({
    providers: [{ provide: SESSION_SNAPSHOT, useValue: snapshot }],
  });
  const sources = new Map<string, Subject<string>>();
  const subscribe = vi.fn(
    (accountId: string): Observable<string> =>
      new Observable<string>((subscriber) => {
        let source = sources.get(accountId);
        if (!source) {
          source = new BehaviorSubject(`${accountId}:0`);
          sources.set(accountId, source);
        }
        return source.subscribe(subscriber);
      }),
  );
  const model = signal<string | null>(null);
  const rebuild = vi.fn((value: string) => model.set(value));
  const reset = vi.fn(() => model.set(null));
  const projection = TestBed.runInInjectionContext(() =>
    projectActiveAccount({ id: ID, subscribe, rebuild, reset, ...over }),
  );
  const tick = () => TestBed.inject(ApplicationRef).tick();
  const conditions: string[] = [];
  TestBed.inject(ProjectionRuntime)
    .observe(ID, { kind: 'active-account' })
    .subscribe((state) => conditions.push(state.condition));
  return {
    projection,
    snapshot,
    sources,
    subscribe,
    rebuild,
    reset,
    model,
    tick,
    conditions,
  };
}

describe('projectActiveAccount', () => {
  it('publishes the first value synchronously on connect and reports the lease', () => {
    const { projection, model, conditions } = harness();

    projection.connect();

    expect(model()).toBe('@a:hs:0');
    expect(projection.accountId()).toBe('@a:hs');
    expect(conditions.at(-1)).toBe('available');
  });

  it('coalesces a burst of values into one rebuild', async () => {
    const { projection, sources, rebuild, model } = harness();
    projection.connect();
    rebuild.mockClear();

    sources.get('@a:hs')?.next('@a:hs:1');
    sources.get('@a:hs')?.next('@a:hs:2');
    await Promise.resolve();

    expect(rebuild).toHaveBeenCalledOnce();
    expect(model()).toBe('@a:hs:2');
  });

  it('waits on the first value before the reconcile is available', async () => {
    const pending = new Subject<string>();
    const { projection, model, conditions } = harness({
      subscribe: () => pending,
    });
    const runtime = TestBed.inject(ProjectionRuntime);
    const ready = vi.fn();
    projection.connect();
    runtime.waitFor({ kind: 'active-account' }, [ID]).subscribe(ready);

    expect(conditions.at(-1)).toBe('reconciling');
    expect(model()).toBeNull();
    expect(ready).not.toHaveBeenCalled();

    pending.next('late');
    await Promise.resolve();

    expect(model()).toBe('late');
    expect(conditions.at(-1)).toBe('available');
    expect(ready).toHaveBeenCalledOnce();
  });

  it('reports a source error as a failed projection', async () => {
    const failing = new Subject<string>();
    const { projection, conditions } = harness({ subscribe: () => failing });
    projection.connect();

    failing.error(new Error('read failed'));
    await Promise.resolve();

    expect(conditions.at(-1)).toBe('failed');
  });

  it('rebuilds the latest value again on invalidate without releasing the lease', async () => {
    let failing = true;
    const { projection, conditions, subscribe } = harness({
      rebuild: (value) => {
        if (failing) throw new Error(`rebuild ${value} failed`);
      },
    });
    projection.connect();
    expect(conditions.at(-1)).toBe('failed');
    const failedAt = conditions.length;

    failing = false;
    projection.invalidate();
    await Promise.resolve();

    expect(conditions.at(-1)).toBe('available');
    expect(conditions.slice(failedAt)).not.toContain('released');
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it('schedule reconciles again from the latest value, recovering a failed rebuild', async () => {
    const { projection, rebuild, model, conditions, subscribe } = harness();
    projection.connect();
    const connected = conditions.length;
    rebuild.mockImplementationOnce(() => {
      throw new Error('rebuild failed');
    });

    projection.schedule();
    await Promise.resolve();
    expect(conditions.at(-1)).toBe('failed');

    projection.schedule();
    await Promise.resolve();

    expect(conditions.at(-1)).toBe('available');
    expect(model()).toBe('@a:hs:0');
    expect(conditions.slice(connected)).not.toContain('released');
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it('follows an account switch, resetting first and never showing the previous value', () => {
    const { projection, snapshot, sources, model, rebuild, reset, tick } =
      harness();
    const seen: (string | null)[] = [];
    projection.connect();
    reset.mockImplementation(() => {
      seen.push('reset');
      model.set(null);
    });
    rebuild.mockImplementation((value: string) => {
      seen.push(value);
      model.set(value);
    });

    snapshot.set(live('@b:hs'));
    tick();
    sources.get('@a:hs')?.next('@a:hs:late');

    expect(seen).toEqual(['reset', '@b:hs:0']);
    expect(model()).toBe('@b:hs:0');
    expect(projection.accountId()).toBe('@b:hs');
    expect(sources.get('@a:hs')?.observed).toBe(false);
  });

  it('re-subscribes when the session generation changes', () => {
    const { projection, snapshot, subscribe, reset, tick } = harness();
    projection.connect();
    tick();

    snapshot.set(live('@a:hs', 2));
    tick();

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledOnce();
  });

  it('ignores a snapshot change that keeps the account and generation', () => {
    const { projection, snapshot, subscribe, tick } = harness();
    projection.connect();
    tick();

    snapshot.set({
      ...live('@a:hs'),
      accounts: [{ ...status('@a:hs'), syncState: 'reconnecting' }],
    });
    tick();

    expect(subscribe).toHaveBeenCalledOnce();
  });

  it('re-subscribes when the runtime transitions the active-account scope', async () => {
    const { projection, subscribe, reset } = harness();
    projection.connect();

    TestBed.inject(ProjectionRuntime)
      .transition({ kind: 'active-account' })
      .subscribe();

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledOnce();
  });

  it('retains dormant demand while signed out and attaches after login', () => {
    const { projection, snapshot, subscribe, model, tick } = harness(
      {},
      EMPTY_SESSION,
    );
    const lifetime = projection.run().subscribe();
    tick();
    expect(subscribe).not.toHaveBeenCalled();

    snapshot.set(live('@a:hs'));
    tick();

    expect(model()).toBe('@a:hs:0');
    lifetime.unsubscribe();
  });

  it('disconnects and resets when the last account signs out', () => {
    const { projection, snapshot, model, tick } = harness();
    projection.connect();
    tick();

    snapshot.set(EMPTY_SESSION);
    tick();

    expect(projection.isConnected()).toBe(false);
    expect(model()).toBeNull();
  });

  it('keeps the subscription until the final owned lifetime releases', () => {
    const { projection, sources, reset } = harness();
    const first = projection.run().subscribe();
    const second = projection.run().subscribe();

    first.unsubscribe();
    expect(sources.get('@a:hs')?.observed).toBe(true);

    second.unsubscribe();
    expect(sources.get('@a:hs')?.observed).toBe(false);
    expect(reset).toHaveBeenCalledOnce();
  });
});
