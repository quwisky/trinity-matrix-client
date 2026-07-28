import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ClientEvent, RoomEvent } from 'matrix-js-sdk';
import type { MatrixClient } from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { projectFromClient } from './project-from-client';
import type { ProjectFromClientConfig } from './project-from-client';
import type { MatrixClientService } from './matrix-client.service';

/** Drain the microtask queue, which is where a coalesced rebuild lands. */
const flush = () => Promise.resolve();

/** A client that records its listeners, so binding and unbinding are both observable. */
function fakeClient(name: string) {
  const listeners = new Map<string, Set<() => void>>();
  const client = {
    name,
    on(event: string, fn: () => void) {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event))?.add(
        fn,
      );
      return client;
    },
    off(event: string, fn: () => void) {
      listeners.get(event)?.delete(fn);
      return client;
    },
    emit(event: string) {
      for (const fn of listeners.get(event) ?? []) {
        fn();
      }
    },
    count: (event: string) => listeners.get(event)?.size ?? 0,
  };
  return client;
}

/** The fake behind a `MatrixClient`-typed reference, for asserting on its listeners. */
const asFake = (client: MatrixClient) =>
  client as unknown as ReturnType<typeof fakeClient>;

function harness(
  over: Partial<ProjectFromClientConfig> = {},
  opts: { initialized?: boolean } = {},
) {
  const client = fakeClient('first');
  const instance = signal(client);
  const activeUserId = signal<string | null>('@a:hs');
  const matrix = {
    get isInitialized() {
      return opts.initialized ?? true;
    },
    get instance() {
      return instance() as unknown as MatrixClient;
    },
    activeUserId: activeUserId.asReadonly(),
  } as unknown as MatrixClientService;

  const rebuild = vi.fn();
  const reset = vi.fn();
  const projection = TestBed.runInInjectionContext(() =>
    projectFromClient({
      matrix,
      rebuild,
      reset,
      events: [ClientEvent.Sync, RoomEvent.Name],
      ...over,
    }),
  );
  const tick = () => TestBed.inject(ApplicationRef).tick();
  return { projection, client, instance, activeUserId, rebuild, reset, tick };
}

describe('projectFromClient', () => {
  it('binds its events and rebuilds synchronously on connect', () => {
    const { projection, client, rebuild } = harness();

    projection.connect();

    // Synchronous, so a consumer reading straight after connect() sees the model.
    expect(rebuild).toHaveBeenCalledOnce();
    expect(client.count(ClientEvent.Sync)).toBe(1);
    expect(client.count(RoomEvent.Name)).toBe(1);
    expect(projection.isConnected()).toBe(true);
  });

  it('does nothing while the client is not initialized', () => {
    const { projection, rebuild } = harness({}, { initialized: false });

    projection.connect();

    expect(rebuild).not.toHaveBeenCalled();
    expect(projection.isConnected()).toBe(false);
  });

  it('is idempotent for the same client', () => {
    const { projection, client, rebuild } = harness();

    projection.connect();
    projection.connect();

    expect(rebuild).toHaveBeenCalledOnce();
    expect(client.count(ClientEvent.Sync)).toBe(1); // not double-bound
  });

  it('rebinds onto a fresh client after a re-login', () => {
    const { projection, client, instance, rebuild } = harness();
    projection.connect();
    const next = fakeClient('second');

    instance.set(next);
    projection.connect();

    // Keyed to the instance: the discarded client keeps no listeners, or the read model
    // would freeze while the new client syncs.
    expect(client.count(ClientEvent.Sync)).toBe(0);
    expect(next.count(ClientEvent.Sync)).toBe(1);
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it('coalesces a burst of events into one rebuild', async () => {
    const { projection, client, rebuild } = harness();
    projection.connect();
    rebuild.mockClear();

    client.emit(ClientEvent.Sync);
    client.emit(ClientEvent.Sync);
    client.emit(RoomEvent.Name);
    expect(rebuild).not.toHaveBeenCalled(); // still collapsing
    await flush();

    expect(rebuild).toHaveBeenCalledOnce();
  });

  it('rebuilds per event when coalescing is off', () => {
    const { projection, client, rebuild } = harness({ coalesce: false });
    projection.connect();
    rebuild.mockClear();

    client.emit(ClientEvent.Sync);
    client.emit(ClientEvent.Sync);

    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it('unbinds, resets, and drops a queued rebuild on disconnect', async () => {
    const { projection, client, rebuild, reset } = harness();
    projection.connect();
    rebuild.mockClear();

    client.emit(ClientEvent.Sync); // queue a rebuild…
    projection.disconnect(); // …then detach before it flushes
    // Flushed BEFORE asserting: a queued rebuild that was never dropped would land here,
    // and without the flush this assertion would pass either way.
    await flush();

    expect(rebuild).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledOnce();
    expect(client.count(ClientEvent.Sync)).toBe(0);
    expect(projection.isConnected()).toBe(false);
  });

  it('gives bind the client and the scheduler, and unbinds what it attached', async () => {
    // The escape hatch for handlers that need the event's arguments, or a second listener
    // group that must not be coalesced. Whatever bind attaches, unbind must remove.
    let attached: (() => void) | null = null;
    let boundTo: MatrixClient | null = null;
    const bind = (client: MatrixClient, scheduleRebuild: () => void): void => {
      boundTo = client;
      attached = scheduleRebuild;
      asFake(client).on(RoomEvent.Receipt, scheduleRebuild);
    };
    const unbind = (client: MatrixClient): void => {
      if (attached) {
        asFake(client).off(RoomEvent.Receipt, attached);
      }
    };
    const { projection, client, rebuild } = harness({ bind, unbind });

    projection.connect();
    rebuild.mockClear();
    client.emit(RoomEvent.Receipt);
    await flush();

    expect(boundTo).toBe(client); // handed the client it actually bound to
    expect(rebuild).toHaveBeenCalledOnce(); // the scheduler it was handed works
    projection.disconnect();
    expect(client.count(RoomEvent.Receipt)).toBe(0); // genuinely detached
  });

  it('re-projects onto the new client when the active account changes', () => {
    const { projection, instance, activeUserId, rebuild, tick } = harness();
    projection.connect();
    tick(); // flush the initial effect run
    rebuild.mockClear();
    const next = fakeClient('second');

    instance.set(next);
    activeUserId.set('@b:hs');
    tick();

    expect(rebuild).toHaveBeenCalledOnce();
    expect(next.count(ClientEvent.Sync)).toBe(1);
  });

  it('does not re-project on a switch while disconnected', () => {
    const { activeUserId, rebuild, tick } = harness();
    tick();

    activeUserId.set('@b:hs');
    tick();

    expect(rebuild).not.toHaveBeenCalled();
  });

  it('can opt out of re-projecting, for a projection the switch already tears down', () => {
    const { projection, activeUserId, rebuild, tick } = harness({
      reprojectOnSwitch: false,
    });
    projection.connect();
    tick();
    rebuild.mockClear();

    activeUserId.set('@b:hs');
    tick();

    expect(rebuild).not.toHaveBeenCalled();
  });
});
