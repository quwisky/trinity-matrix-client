import { TestBed } from '@angular/core/testing';
import { ClientEvent, MatrixError } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import type { AccountDataSnapshot } from '../expression-engine';
import { JsSdkExpressionEngine } from './js-sdk-expression-engine';

const ALICE = '@alice:hs';

function matrixError(errcode: string, httpStatus: number): MatrixError {
  return new MatrixError({ errcode, error: errcode }, httpStatus);
}

function fakeClient() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const data = new Map<string, unknown>();
  return {
    data,
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event))?.add(
        fn,
      );
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
    },
    getUserId: () => ALICE,
    getAccountData: (type: string) =>
      data.has(type) ? { getContent: () => data.get(type) } : undefined,
    getRoom: vi.fn((): unknown => null),
    http: { authedRequest: vi.fn() },
    setAccountDataRaw: vi.fn().mockResolvedValue({}),
    getStateEvent: vi.fn(),
    sendStateEvent: vi.fn().mockResolvedValue({}),
    getRoomIdForAlias: vi.fn(),
    joinRoom: vi.fn().mockResolvedValue({}),
    roomState: vi.fn().mockResolvedValue([]),
  };
}

describe('JsSdkExpressionEngine', () => {
  let client: ReturnType<typeof fakeClient>;
  let live: ReturnType<typeof fakeClient> | null;
  let engine: JsSdkExpressionEngine;

  beforeEach(() => {
    client = fakeClient();
    live = client;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: JS_SDK_CLIENTS,
          useValue: {
            clientFor: (id: string) => (id === ALICE ? live : null),
          },
        },
      ],
    });
    engine = TestBed.inject(JsSdkExpressionEngine);
  });

  const accountDataEvent = (type: string) => ({ getType: () => type });

  it('emits the account-data snapshot synchronously, then once per burst of watched changes', async () => {
    client.data.set('a', { n: 1 });
    const seen: AccountDataSnapshot[] = [];
    const subscription = engine
      .accountData(ALICE, ['a', 'b'])
      .subscribe((snapshot) => seen.push(snapshot));
    expect(seen).toEqual([{ a: { n: 1 }, b: null }]);

    client.emit(ClientEvent.AccountData, accountDataEvent('unrelated'));
    client.data.set('b', { n: 2 });
    client.emit(ClientEvent.AccountData, accountDataEvent('b'));
    client.emit(ClientEvent.AccountData, accountDataEvent('b'));
    await Promise.resolve();

    expect(seen).toEqual([
      { a: { n: 1 }, b: null },
      { a: { n: 1 }, b: { n: 2 } },
    ]);
    subscription.unsubscribe();
  });

  it('stops following a client the account no longer has', async () => {
    const seen: AccountDataSnapshot[] = [];
    engine.accountData(ALICE, ['a']).subscribe((s) => seen.push(s));
    live = fakeClient();

    client.data.set('a', { n: 1 });
    client.emit(ClientEvent.AccountData, accountDataEvent('a'));
    await Promise.resolve();

    expect(seen).toEqual([{ a: null }]);
  });

  it('reads account data from the server, null on M_NOT_FOUND', async () => {
    client.http.authedRequest.mockResolvedValueOnce({ fresh: true });
    expect(await firstValueFrom(engine.fetchAccountData(ALICE, 'x/y'))).toEqual(
      { ok: true, value: { fresh: true } },
    );
    expect(client.http.authedRequest).toHaveBeenCalledWith(
      'GET',
      `/user/${encodeURIComponent(ALICE)}/account_data/x%2Fy`,
    );

    client.http.authedRequest.mockRejectedValueOnce(
      matrixError('M_NOT_FOUND', 404),
    );
    expect(await firstValueFrom(engine.fetchAccountData(ALICE, 'x'))).toEqual({
      ok: true,
      value: null,
    });
  });

  it('maps M_TOO_LARGE to too-large and M_FORBIDDEN to a permission failure', async () => {
    client.sendStateEvent.mockRejectedValueOnce(
      matrixError('M_TOO_LARGE', 413),
    );
    const tooLarge = await firstValueFrom(
      engine.setRoomState(ALICE, '!r', 't', '', {}),
    );
    client.setAccountDataRaw.mockRejectedValueOnce(
      matrixError('M_FORBIDDEN', 403),
    );
    const forbidden = await firstValueFrom(
      engine.setAccountData(ALICE, 't', {}),
    );

    expect(!tooLarge.ok && tooLarge.failure.code).toBe('too-large');
    expect(!forbidden.ok && forbidden.failure).toMatchObject({
      code: 'request-failed',
      kind: 'permission',
    });
  });

  it('fetches room state, null on M_NOT_FOUND', async () => {
    client.getStateEvent.mockRejectedValueOnce(matrixError('M_NOT_FOUND', 404));

    expect(
      await firstValueFrom(engine.fetchRoomState(ALICE, '!r', 't', 'k')),
    ).toEqual({ ok: true, value: null });
    expect(client.getStateEvent).toHaveBeenCalledWith('!r', 't', 'k');
  });

  it('resolves an alias, joins via its servers and returns the pack state', async () => {
    client.getRoomIdForAlias.mockResolvedValue({
      room_id: '!r:hs',
      servers: ['hs'],
    });
    client.roomState.mockResolvedValue([
      { type: 'm.room.name', state_key: '', content: { name: 'Packs' } },
      { type: 'm.room.image_pack', state_key: 'k', content: { images: {} } },
      { type: 'm.room.member', state_key: ALICE, content: {} },
    ]);

    const result = await firstValueFrom(engine.joinPackRoom(ALICE, '#p:hs'));

    expect(client.joinRoom).toHaveBeenCalledWith('!r:hs', {
      viaServers: ['hs'],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        roomId: '!r:hs',
        roomName: 'Packs',
        events: [
          {
            type: 'm.room.image_pack',
            state_key: 'k',
            content: { images: {} },
          },
        ],
      },
    });
  });

  it('does not join a room the account is already in', async () => {
    client.getRoom.mockReturnValue({
      getMyMembership: () => 'join',
      name: 'Local',
    });

    const result = await firstValueFrom(engine.joinPackRoom(ALICE, '!r:hs'));

    expect(client.joinRoom).not.toHaveBeenCalled();
    expect(result.ok && result.value.roomName).toBe('Local');
  });
});
