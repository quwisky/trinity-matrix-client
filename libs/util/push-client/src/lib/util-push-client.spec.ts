import { defer, firstValueFrom, of, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  createPushAccountRoute,
  createTrinityPusherDescriptor,
  isValidPushAccountRoute,
  parseTrinityPushPayload,
  resolvePushAccountRoute,
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

  it('serializes overlapping registration operations', async () => {
    const active: string[] = [];
    const seen: string[] = [];
    const adapter = {
      register: vi.fn(
        (_account: { accountId: string }, descriptor: { pushkey: string }) => {
          active.push(descriptor.pushkey);
          expect(active).toHaveLength(1);
          seen.push(descriptor.pushkey);
          active.pop();
          return of(undefined);
        },
      ),
    };
    const coordinator = new TrinityPushRegistrationCoordinator(adapter);
    await Promise.all([
      firstValueFrom(
        coordinator.register({
          platform: 'ios',
          pushkey: 'one',
          accounts: [{ accountId: 'a', route: 'route-a' }],
        }),
      ),
      firstValueFrom(
        coordinator.register({
          platform: 'ios',
          pushkey: 'two',
          accounts: [{ accountId: 'b', route: 'route-b' }],
        }),
      ),
    ]);
    expect(seen).toEqual(['one', 'two']);
  });

  it('keeps asynchronous queue order after cancellation and failure', async () => {
    const gate = new Subject<void>();
    const seen: string[] = [];
    const adapter = {
      register: vi.fn(
        (account: { accountId: string }, descriptor: { pushkey: string }) =>
          defer(() => {
            seen.push(`${account.accountId}:${descriptor.pushkey}`);
            if (descriptor.pushkey === 'one') return gate;
            if (descriptor.pushkey === 'two') throw new Error('failed');
            return of(undefined);
          }),
      ),
    };
    const coordinator = new TrinityPushRegistrationCoordinator(adapter);
    const first = coordinator.register({
      platform: 'android',
      pushkey: 'one',
      accounts: [{ accountId: 'a', route: 'route-a' }],
    });
    const second = coordinator.register({
      platform: 'android',
      pushkey: 'two',
      accounts: [{ accountId: 'b', route: 'route-b' }],
    });
    const third = coordinator.register({
      platform: 'android',
      pushkey: 'three',
      accounts: [{ accountId: 'c', route: 'route-c' }],
    });
    const firstPromise = firstValueFrom(first);
    const secondSubscription = second.subscribe({ error: () => undefined });
    secondSubscription.unsubscribe();
    const thirdPromise = firstValueFrom(third);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(['a:one']);
    gate.next();
    gate.complete();
    await firstPromise;
    await thirdPromise;
    expect(seen).toEqual(['a:one', 'b:two', 'c:three']);
  });

  it('is cold, forwards a custom URL, preserves identities, and handles empty accounts', async () => {
    const adapter = {
      register: vi.fn((_account: { accountId: string }, _descriptor: unknown) =>
        of(undefined),
      ),
    };
    const coordinator = new TrinityPushRegistrationCoordinator(adapter);
    const options = {
      platform: 'ios' as const,
      pushkey: 'token',
      gatewayUrl: 'https://gateway.test/_matrix/push/v1/notify',
      accounts: [
        { accountId: 'account-a', route: 'route-a' },
        { accountId: 'account-b', route: 'route-b' },
      ] as const,
    };
    const operation = coordinator.register(options);
    expect(adapter.register).not.toHaveBeenCalled();
    await firstValueFrom(operation);
    expect(adapter.register).toHaveBeenCalledTimes(2);
    expect(
      adapter.register.mock.calls.map(([account, descriptor]) => [
        account.accountId,
        (descriptor as { url: string }).url,
      ]),
    ).toEqual([
      ['account-a', options.gatewayUrl],
      ['account-b', options.gatewayUrl],
    ]);
    const empty = coordinator.register({ ...options, accounts: [] });
    await firstValueFrom(empty);
    expect(adapter.register).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    'continues a failed account and unblocks the next group (synchronous: %s)',
    async (synchronous) => {
      const seen: string[] = [];
      const adapter = {
        register: vi.fn(
          (account: { accountId: string }, _descriptor: unknown) => {
            seen.push(account.accountId);
            if (synchronous && account.accountId === 'account-a')
              throw new Error('registration failed');
            return account.accountId === 'account-a'
              ? defer(() => {
                  throw new Error('registration failed');
                })
              : of(undefined);
          },
        ),
      };
      const coordinator = new TrinityPushRegistrationCoordinator(adapter);
      const first = coordinator.register({
        platform: 'android',
        pushkey: 'one',
        accounts: [
          { accountId: 'account-a', route: 'route-a' },
          { accountId: 'account-b', route: 'route-b' },
        ],
      });
      await expect(firstValueFrom(first)).rejects.toThrow(
        'registration failed',
      );
      const second = coordinator.register({
        platform: 'android',
        pushkey: 'two',
        accounts: [{ accountId: 'account-c', route: 'route-c' }],
      });
      await firstValueFrom(second);
      expect(seen).toEqual(['account-a', 'account-b', 'account-c']);
    },
  );
});
