import { TestBed } from '@angular/core/testing';
import { HttpApiEvent, SyncState, ClientEvent } from 'matrix-js-sdk';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStateService } from '../session-state.service';
import { toSessionSyncState } from './js-sdk-session-engine';
import { MatrixClientService } from './matrix-client.service';
import {
  SESSION,
  SESSION_B,
  fakeClient,
  setup,
} from './matrix-client.spec-harness';

vi.mock('matrix-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('matrix-js-sdk')>();
  return {
    ...actual,
    createClient: vi.fn(),
    IndexedDBStore: class {
      startup = vi.fn().mockResolvedValue(undefined);
      destroy = vi.fn().mockResolvedValue(undefined);
    },
  };
});

vi.mock('./crypto-wasm-loader', async () => {
  const { of: rxOf } = await import('rxjs');
  return { preloadCryptoWasm: () => rxOf(undefined) };
});

type Handler = (...args: never[]) => void;

function handler(client: ReturnType<typeof fakeClient>, event: string) {
  return client.on.mock.calls.find(([e]) => e === event)![1] as Handler;
}

describe('SessionStateService parity with MatrixClientService', () => {
  let svc: MatrixClientService;
  let state: SessionStateService;
  let clients: ReturnType<typeof fakeClient>[];

  function expectParity(): void {
    const accounts = new Map(svc.all().map((a) => [a.userId, a]));
    const active = accounts.get(svc.activeUserId() ?? '');
    const activeSync = active?.syncState() ?? null;
    expect(state.activeAccountId()).toBe(svc.activeUserId());
    expect(state.accountIds()).toEqual(svc.accountIds());
    expect(state.softLoggedOut()).toEqual(svc.softLoggedOut());
    expect(state.connectivity()).toBe(
      activeSync === SyncState.Error || activeSync === SyncState.Reconnecting
        ? 'offline'
        : 'online',
    );
    expect(state.waitingCount()).toBe(active?.waitingCount() ?? 0);
    expect(state.cryptoStoreEncrypted()).toBe(
      active?.cryptoStoreEncrypted ?? null,
    );
    expect(state.syncState()).toBe(
      svc.activeUserId() === null ? null : toSessionSyncState(activeSync),
    );
    for (const id of [SESSION.userId, SESSION_B.userId]) {
      const live = svc.accountIds().includes(id);
      expect(state.status(id)?.serverSynced ?? false).toBe(
        accounts.get(id)?.serverSynced() ?? false,
      );
      expect(state.status(id)?.roomsPrepared ?? false).toBe(
        accounts.get(id)?.roomsPrepared() ?? false,
      );
      expect(state.status(id) !== null).toBe(live);
    }
  }

  beforeEach(() => {
    const a = fakeClient();
    const b = fakeClient('https://other.example');
    const harness = setup(a, b);
    svc = harness.svc;
    vi.mocked(harness.storage.invalidateToken).mockReturnValue(of(undefined));
    vi.mocked(harness.storage.setActive).mockReturnValue(of(undefined));
    vi.mocked(harness.storage.remove).mockReturnValue(of(undefined));
    state = TestBed.inject(SessionStateService);
    clients = [a, b];
  });

  it('matches after every step, in the same turn', async () => {
    const [a, b] = clients;
    expectParity();

    await firstValueFrom(svc.restorePersisted(SESSION, 'activate'));
    expectParity();

    await firstValueFrom(svc.restorePersisted(SESSION_B, 'background'));
    expectParity();

    svc.setActive(SESSION.userId);
    expectParity();

    handler(b, ClientEvent.Sync)(SyncState.Syncing as never, null as never);
    expectParity();

    handler(
      b,
      HttpApiEvent.SessionLoggedOut,
    )({
      data: { soft_logout: true },
    } as never);
    expectParity();
    expect(state.softLoggedOut()).toEqual([SESSION_B.userId]);

    await firstValueFrom(svc.remove(SESSION.userId));
    expectParity();

    await firstValueFrom(svc.stop());
    expectParity();
    expect(a.stopClient).toHaveBeenCalled();
  });
});
