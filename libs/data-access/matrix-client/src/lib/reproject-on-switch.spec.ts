import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { reprojectOnAccountSwitch } from './reproject-on-switch';
import type { MatrixClientService } from './matrix-client.service';

function harness(isConnected: () => boolean) {
  const activeUserId = signal<string | null>('@a:hs');
  const connect = vi.fn();
  const disconnect = vi.fn();
  const matrix = {
    activeUserId: activeUserId.asReadonly(),
    // The real getter reads the active account, so it is false exactly when the active
    // id is null (the last account signing out).
    get isInitialized(): boolean {
      return activeUserId() !== null;
    },
  } as unknown as MatrixClientService;
  TestBed.runInInjectionContext(() =>
    reprojectOnAccountSwitch(matrix, isConnected, connect, disconnect),
  );
  const tick = () => TestBed.inject(ApplicationRef).tick();
  return { activeUserId, connect, disconnect, tick };
}

describe('reprojectOnAccountSwitch', () => {
  it('re-connects when the active account changes while connected', () => {
    const { activeUserId, connect, tick } = harness(() => true);
    tick(); // flush the initial effect run
    connect.mockClear();

    activeUserId.set('@b:hs');
    tick();

    expect(connect).toHaveBeenCalledOnce();
  });

  it('does nothing on a switch while the service is not connected', () => {
    const { activeUserId, connect, disconnect, tick } = harness(() => false);
    tick();

    activeUserId.set('@b:hs');
    tick();

    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('reads the connected guard at switch time, not when the effect was wired', () => {
    let connected = false;
    const { activeUserId, connect, tick } = harness(() => connected);
    tick(); // initial run: guard false → no connect
    expect(connect).not.toHaveBeenCalled();

    // The service connects lazily: isConnected is a plain function, not a tracked
    // signal, so flipping it does not re-run the effect on its own.
    connected = true;
    tick();
    expect(connect).not.toHaveBeenCalled();

    // A real account switch re-runs the effect, which now reads the guard as true.
    activeUserId.set('@b:hs');
    tick();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('disconnects — never connects — when the last account signs out', () => {
    // connect() early-returns when nothing is initialized, so calling it here would
    // leave the projection holding the stopped client's data (M3).
    const { activeUserId, connect, disconnect, tick } = harness(() => true);
    tick();
    connect.mockClear();

    activeUserId.set(null);
    tick();

    expect(disconnect).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
  });
});
