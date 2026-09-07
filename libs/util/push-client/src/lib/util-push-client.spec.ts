import { defer, firstValueFrom, of, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  createPushAccountRoute,
  createTrinityPusherDescriptor,
  isValidPushAccountRoute,
  isTrinityPushRegistrationState,
  parseTrinityPushPayload,
  resolvePushAccountRoute,
  type TrinityPushRegistrationAdapter,
  type TrinityPushRegistrationState,
  TrinityPushRegistrationCoordinator,
} from './util-push-client';

describe('push client contract', () => {
  it('creates unique opaque base64url routes and retries collisions', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    let attempt = 0;
    const route = createPushAccountRoute(
      [{ accountId: 'a', route: 'AQID' }],
      () => {
        attempt += 1;
        return attempt === 1 ? bytes : new Uint8Array([4, 5, 6]);
      },
    );
    expect(route).toBe('BAUG');
    expect(attempt).toBe(2);
    expect(isValidPushAccountRoute(route)).toBe(true);
  });

  it('rejects missing and ambiguous route ownership', () => {
    const records = [{ accountId: 'a', route: 'route-a' }];
    expect(resolvePushAccountRoute(records, 'missing')).toBeNull();
    expect(resolvePushAccountRoute(records, 'bad route')).toBeNull();
    expect(
      resolvePushAccountRoute(
        [...records, { accountId: 'b', route: 'route-a' }],
        'route-a',
      ),
    ).toBeNull();
  });

  it('parses event and count payloads while rejecting malformed values', () => {
    const event = parseTrinityPushPayload({
      schema: '1',
      kind: 'event',
      trinity_account_id: 'route-a',
      event_id: '$event',
      room_id: '!room',
      unread: '2',
      missed_calls: '0',
      sound: 'true',
      highlight: 'false',
    });
    expect(event).toMatchObject({
      kind: 'event',
      accountRoute: 'route-a',
      eventId: '$event',
      roomId: '!room',
      unread: 2,
      sound: true,
      highlight: false,
    });
    expect(
      parseTrinityPushPayload({
        schema: '1',
        kind: 'counts',
        trinity_account_id: 'route-a',
        unread: '9007199254740992',
        missed_calls: '0',
        sound: 'false',
      }),
    ).toBeNull();
    expect(
      parseTrinityPushPayload({
        schema: '1',
        kind: 'event',
        trinity_account_id: 'route-a',
        event_id: '$event',
        unread: '1',
        missed_calls: '0',
        sound: 'true',
      }),
    ).toBeNull();
    expect(
      parseTrinityPushPayload({
        schema: '1',
        kind: 'counts',
        trinity_account_id: 'route-a',
        unread: '3',
        missed_calls: '1',
        sound: 'false',
      }),
    ).toMatchObject({
      kind: 'counts',
      unread: 3,
      missedCalls: 1,
      sound: false,
    });
    expect(
      parseTrinityPushPayload({
        schema: '2',
        kind: 'counts',
        trinity_account_id: 'route-a',
        unread: '3',
        missed_calls: '1',
        sound: 'false',
      }),
    ).toBeNull();
    expect(
      parseTrinityPushPayload({
        schema: '1',
        kind: 'counts',
        trinity_account_id: 'route-a',
        unread: '3',
        missed_calls: '1',
        sound: 'yes',
      }),
    ).toBeNull();
    expect(
      parseTrinityPushPayload({
        schema: '1',
        kind: 'counts',
        trinity_account_id: 'bad route',
        unread: '3',
        missed_calls: '1',
        sound: 'false',
      }),
    ).toBeNull();
  });

  it('builds the version-one append descriptor', () => {
    expect(
      createTrinityPusherDescriptor({
        platform: 'android',
        pushkey: 'token',
        accountRoute: 'route-a',
      }),
    ).toEqual({
      kind: 'http',
      appId: 'ovh.qwky.trinity.android',
      pushkey: 'token',
      url: 'https://push.example.invalid/_matrix/push/v1/notify',
      append: true,
      data: {
        format: 'event_id_only',
        trinity_account_id: 'route-a',
        trinity_push_version: '1',
      },
    });
  });

  it('recovers registration with durable stale cleanup and readback', async () => {
    const state: TrinityPushRegistrationState = {
      version: 1,
      identities: [{ appId: 'ovh.qwky.trinity.android', pushkey: 'old' }],
    };
    const saved: unknown[] = [];
    const adapter: TrinityPushRegistrationAdapter = {
      load: vi.fn(() => of(state)),
      save: vi.fn((_id, value) => {
        saved.push(value);
        return of(undefined);
      }),
      list: vi
        .fn()
        .mockReturnValueOnce(
          of([
            {
              appId: 'ovh.qwky.trinity.android',
              pushkey: 'old',
              kind: 'http',
              url: 'https://push.example.invalid/_matrix/push/v1/notify',
              format: 'event_id_only',
              version: '1',
              deviceDisplayName: 'Phone',
              appDisplayName: 'Trinity',
            },
          ]),
        )
        .mockReturnValueOnce(of([]))
        .mockReturnValueOnce(
          of([
            {
              appId: 'ovh.qwky.trinity.android',
              pushkey: 'new',
              kind: 'http',
              url: 'https://push.example.invalid/_matrix/push/v1/notify',
              format: 'event_id_only',
              version: '1',
              deviceDisplayName: 'Phone',
              accountRoute: 'route-a',
            },
          ]),
        ),
      register: vi.fn(() => of(undefined)),
      remove: vi.fn(() => of(undefined)),
    };
    const report = await firstValueFrom(
      new TrinityPushRegistrationCoordinator(adapter).register({
        platform: 'android',
        pushkey: 'new',
        accounts: [
          { accountId: 'a', route: 'route-a', deviceDisplayName: 'Phone' },
        ],
      }),
    );
    expect(report).toEqual({ applied: ['a'], failed: [] });
    expect(adapter.remove).toHaveBeenCalledWith('a', {
      appId: 'ovh.qwky.trinity.android',
      pushkey: 'old',
    });
    expect(saved).toHaveLength(2);
  });

  it('keeps the queue alive after cancellation and continues other accounts', async () => {
    const gate = new Subject<void>();
    const seen: string[] = [];
    const adapter: TrinityPushRegistrationAdapter = {
      load: vi.fn(() => of(null)),
      save: vi.fn(() => of(undefined)),
      list: vi.fn(() =>
        of([
          {
            appId: 'ovh.qwky.trinity.android',
            pushkey: 'x',
            kind: 'http',
            url: 'https://push.example.invalid/_matrix/push/v1/notify',
            format: 'event_id_only',
            version: '1',
            deviceDisplayName: 'Phone',
            accountRoute: 'route-a',
          },
        ]),
      ),
      register: vi.fn((account) =>
        defer(() => {
          seen.push(account.accountId);
          return account.accountId === 'a' ? gate : of(undefined);
        }),
      ),
      remove: vi.fn(() => of(undefined)),
    };
    const coordinator = new TrinityPushRegistrationCoordinator(adapter);
    const first = firstValueFrom(
      coordinator.register({
        platform: 'android',
        pushkey: 'x',
        accounts: [
          { accountId: 'a', route: 'route-a', deviceDisplayName: 'Phone' },
        ],
      }),
    );
    coordinator
      .register({
        platform: 'android',
        pushkey: 'x',
        accounts: [
          { accountId: 'b', route: 'route-b', deviceDisplayName: 'Phone' },
        ],
      })
      .subscribe()
      .unsubscribe();
    const third = firstValueFrom(
      coordinator.register({
        platform: 'android',
        pushkey: 'x',
        accounts: [
          { accountId: 'c', route: 'route-c', deviceDisplayName: 'Phone' },
        ],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(['a']);
    gate.next();
    gate.complete();
    await first;
    await third;
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('does not delete another installation during unregister', async () => {
    const adapter: TrinityPushRegistrationAdapter = {
      load: vi.fn(() => of(null)),
      save: vi.fn(() => of(undefined)),
      register: vi.fn(() => of(undefined)),
      remove: vi.fn(() => of(undefined)),
      list: vi.fn(() =>
        of([
          {
            appId: 'ovh.qwky.trinity.android',
            pushkey: 'other',
            kind: 'http',
            url: 'https://push.example.invalid/_matrix/push/v1/notify',
            format: 'event_id_only',
            version: '1',
            deviceDisplayName: 'Other Phone',
            appDisplayName: 'Trinity',
          },
        ]),
      ),
    };
    const result = await firstValueFrom(
      new TrinityPushRegistrationCoordinator(adapter).unregister({
        platform: 'android',
        legacyAppIds: ['ovh.qwky.trinity.android'],
        accounts: [{ accountId: 'a', deviceDisplayName: 'Phone' }],
      }),
    );
    expect(result).toEqual({ applied: ['a'], failed: [] });
    expect(adapter.remove).not.toHaveBeenCalled();
    expect(adapter.save).toHaveBeenCalledWith('a', null);
  });

  it('is cold and waits for completion after a nonterminal adapter emission', async () => {
    const registered = new Subject<void>();
    const adapter: TrinityPushRegistrationAdapter = {
      load: vi.fn(() => of(null)),
      save: vi.fn(() => of(undefined)),
      list: vi.fn(() =>
        of([
          {
            appId: 'ovh.qwky.trinity.android',
            pushkey: 'x',
            kind: 'http',
            url: 'https://push.example.invalid/_matrix/push/v1/notify',
            format: 'event_id_only',
            version: '1',
            deviceDisplayName: 'A',
            accountRoute: 'r',
          },
        ]),
      ),
      remove: vi.fn(() => of(undefined)),
      register: vi.fn(() => registered),
    };
    const operation = new TrinityPushRegistrationCoordinator(adapter).register({
      platform: 'android',
      pushkey: 'x',
      accounts: [{ accountId: 'a', route: 'r', deviceDisplayName: 'A' }],
    });
    expect(adapter.load).not.toHaveBeenCalled();
    let completed = false;
    const result = firstValueFrom(operation).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    registered.next();
    registered.complete();
    await result;
  });

  it('keeps write-ahead state after final-save failure and repairs after restart', async () => {
    let stored: TrinityPushRegistrationState | null = null;
    let saveCount = 0;
    const adapter: TrinityPushRegistrationAdapter = {
      load: vi.fn(() => of(stored)),
      list: vi.fn(() =>
        of([
          {
            appId: 'ovh.qwky.trinity.android',
            pushkey: 'x',
            kind: 'http',
            url: 'https://push.example.invalid/_matrix/push/v1/notify',
            format: 'event_id_only',
            version: '1',
            deviceDisplayName: 'A',
            accountRoute: 'r',
          },
        ]),
      ),
      remove: vi.fn(() => of(undefined)),
      register: vi.fn(() => of(undefined)),
      save: vi.fn((_id, value) => {
        saveCount++;
        if (saveCount === 2)
          return defer(() => {
            throw new Error('storage');
          });
        stored = value;
        return of(undefined);
      }),
    };
    const options = {
      platform: 'android' as const,
      pushkey: 'x',
      accounts: [{ accountId: 'a', route: 'r', deviceDisplayName: 'A' }],
    };
    expect(
      (
        await firstValueFrom(
          new TrinityPushRegistrationCoordinator(adapter).register(options),
        )
      ).failed,
    ).toEqual([{ accountId: 'a', code: 'save-failed' }]);
    saveCount = 99;
    expect(
      (
        await firstValueFrom(
          new TrinityPushRegistrationCoordinator(adapter).register(options),
        )
      ).applied,
    ).toEqual(['a']);
  });

  it('does not remove or set when the write-ahead save fails', async () => {
    const adapter: TrinityPushRegistrationAdapter = {
      load: vi.fn(() =>
        of({
          version: 1 as const,
          identities: [{ appId: 'legacy', pushkey: 'old' }],
        }),
      ),
      save: vi.fn(() =>
        defer(() => {
          throw new Error('storage');
        }),
      ),
      list: vi.fn(() => of([])),
      remove: vi.fn(() => of(undefined)),
      register: vi.fn(() => of(undefined)),
    };
    const result = await firstValueFrom(
      new TrinityPushRegistrationCoordinator(adapter).register({
        platform: 'android',
        pushkey: 'new',
        accounts: [{ accountId: 'a', route: 'r', deviceDisplayName: 'A' }],
      }),
    );
    expect(result.failed).toEqual([{ accountId: 'a', code: 'save-failed' }]);
    expect(adapter.remove).not.toHaveBeenCalled();
    expect(adapter.register).not.toHaveBeenCalled();
  });

  it('fails stale cleanup when a successful remove leaves the remote row', async () => {
    const stale = {
      appId: 'ovh.qwky.trinity.android',
      pushkey: 'old',
      kind: 'http',
      url: 'https://push.example.invalid/_matrix/push/v1/notify',
      format: 'event_id_only',
      version: '1',
      deviceDisplayName: 'A',
      accountRoute: 'r',
    };
    const adapter: TrinityPushRegistrationAdapter = {
      load: vi.fn(() => of(null)),
      save: vi.fn(() => of(undefined)),
      list: vi.fn(() => of([stale])),
      remove: vi.fn(() => of(undefined)),
      register: vi.fn(() => of(undefined)),
    };
    const result = await firstValueFrom(
      new TrinityPushRegistrationCoordinator(adapter).register({
        platform: 'android',
        pushkey: 'new',
        accounts: [{ accountId: 'a', route: 'r', deviceDisplayName: 'A' }],
      }),
    );
    expect(result.failed).toEqual([{ accountId: 'a', code: 'remove-failed' }]);
    expect(adapter.register).not.toHaveBeenCalled();
  });

  it('retains a failed legacy removal and retries it before setting the new pusher', async () => {
    const legacy = {
      appId: 'legacy.app',
      pushkey: 'old',
      kind: 'http',
      url: 'https://push.example.invalid/_matrix/push/v1/notify',
      format: 'event_id_only',
      version: '1',
      deviceDisplayName: 'A',
      appDisplayName: 'Trinity',
    };
    let attempts = 0;
    const adapter: TrinityPushRegistrationAdapter = {
      load: vi.fn(() => of(null)),
      save: vi.fn(() => of(undefined)),
      list: vi.fn(() =>
        attempts > 1
          ? of([
              {
                appId: 'ovh.qwky.trinity.android',
                pushkey: 'new',
                kind: 'http',
                url: 'https://push.example.invalid/_matrix/push/v1/notify',
                format: 'event_id_only',
                version: '1',
                deviceDisplayName: 'A',
                accountRoute: 'r',
              },
            ])
          : of([legacy]),
      ),
      remove: vi.fn(() => {
        attempts++;
        return attempts === 1
          ? defer(() => {
              throw new Error('down');
            })
          : of(undefined);
      }),
      register: vi.fn(() => of(undefined)),
    };
    const options = {
      platform: 'android' as const,
      pushkey: 'new',
      legacyAppIds: ['legacy.app'],
      accounts: [{ accountId: 'a', route: 'r', deviceDisplayName: 'A' }],
    };
    expect(
      (
        await firstValueFrom(
          new TrinityPushRegistrationCoordinator(adapter).register(options),
        )
      ).failed,
    ).toEqual([{ accountId: 'a', code: 'remove-failed' }]);
    expect(
      (
        await firstValueFrom(
          new TrinityPushRegistrationCoordinator(adapter).register(options),
        )
      ).applied,
    ).toEqual(['a']);
    expect(adapter.register).toHaveBeenCalledOnce();
  });

  it('repairs a missing pusher but does not mark it applied when readback fails', async () => {
    const adapter: TrinityPushRegistrationAdapter = {
      load: vi.fn(() => of(null)),
      save: vi.fn(() => of(undefined)),
      list: vi
        .fn()
        .mockReturnValueOnce(of([]))
        .mockReturnValueOnce(of([]))
        .mockReturnValueOnce(
          defer(() => {
            throw new Error('get');
          }),
        ),
      remove: vi.fn(() => of(undefined)),
      register: vi.fn(() => of(undefined)),
    };
    const result = await firstValueFrom(
      new TrinityPushRegistrationCoordinator(adapter).register({
        platform: 'android',
        pushkey: 'x',
        accounts: [{ accountId: 'a', route: 'r', deviceDisplayName: 'A' }],
      }),
    );
    expect(result.failed).toEqual([
      { accountId: 'a', code: 'readback-failed' },
    ]);
    expect(adapter.register).toHaveBeenCalledOnce();
  });

  it('rejects corrupt applied descriptors instead of copying them', () => {
    expect(
      isTrinityPushRegistrationState({
        version: 1,
        identities: [],
        applied: { appId: 'bad' },
      }),
    ).toBe(false);
  });

  it('rejects readback from an old gateway or wrong pusher metadata', async () => {
    const adapter: TrinityPushRegistrationAdapter = {
      load: vi.fn(() => of(null)),
      save: vi.fn(() => of(undefined)),
      list: vi
        .fn()
        .mockReturnValueOnce(of([]))
        .mockReturnValueOnce(of([]))
        .mockReturnValueOnce(
          of([
            {
              appId: 'ovh.qwky.trinity.android',
              pushkey: 'x',
              kind: 'http',
              url: 'https://old-gateway',
              format: 'event_id_only',
              version: '1',
              deviceDisplayName: 'A',
              accountRoute: 'r',
            },
          ]),
        ),
      remove: vi.fn(() => of(undefined)),
      register: vi.fn(() => of(undefined)),
    };
    const result = await firstValueFrom(
      new TrinityPushRegistrationCoordinator(adapter).register({
        platform: 'android',
        gatewayUrl: 'https://new-gateway',
        pushkey: 'x',
        accounts: [{ accountId: 'a', route: 'r', deviceDisplayName: 'A' }],
      }),
    );
    expect(result.failed).toEqual([
      { accountId: 'a', code: 'readback-failed' },
    ]);
  });

  it('keeps shared-token accounts and device identities independent', async () => {
    const adapter: TrinityPushRegistrationAdapter = {
      load: vi.fn(() => of(null)),
      save: vi.fn(() => of(undefined)),
      list: vi.fn((id) =>
        of([
          {
            appId: 'ovh.qwky.trinity.android',
            pushkey: 'shared',
            kind: 'http',
            url: 'https://new',
            format: 'event_id_only',
            version: '1',
            deviceDisplayName: id === 'a' ? 'A' : 'B',
            accountRoute: id === 'a' ? 'ra' : 'rb',
          },
        ]),
      ),
      remove: vi.fn(() => of(undefined)),
      register: vi.fn(() => of(undefined)),
    };
    const result = await firstValueFrom(
      new TrinityPushRegistrationCoordinator(adapter).register({
        platform: 'android',
        pushkey: 'shared',
        gatewayUrl: 'https://new',
        accounts: [
          { accountId: 'a', route: 'ra', deviceDisplayName: 'A' },
          { accountId: 'b', route: 'rb', deviceDisplayName: 'B' },
        ],
      }),
    );
    expect(result).toEqual({ applied: ['a', 'b'], failed: [] });
    expect(adapter.register).toHaveBeenCalledTimes(2);
    expect(
      (adapter.register as ReturnType<typeof vi.fn>).mock.calls[0][1].url,
    ).toBe('https://new');
  });

  it('serializes an unsubscribed unregister behind registration', async () => {
    const order: string[] = [];
    const gate = new Subject<void>();
    const adapter: TrinityPushRegistrationAdapter = {
      load: vi.fn(() => of(null)),
      save: vi.fn(() => of(undefined)),
      list: vi.fn(() => of([])),
      remove: vi.fn(() => of(undefined)),
      register: vi.fn(() =>
        defer(() => {
          order.push('register');
          return gate;
        }),
      ),
    };
    const coordinator = new TrinityPushRegistrationCoordinator(adapter);
    const first = firstValueFrom(
      coordinator.register({
        platform: 'android',
        pushkey: 'x',
        accounts: [{ accountId: 'a', route: 'r', deviceDisplayName: 'A' }],
      }),
    );
    coordinator
      .unregister({
        platform: 'android',
        accounts: [{ accountId: 'a', deviceDisplayName: 'A' }],
      })
      .subscribe()
      .unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['register']);
    gate.next();
    gate.complete();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.save).toHaveBeenCalled();
  });
});
