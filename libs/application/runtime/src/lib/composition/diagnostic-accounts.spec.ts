import { signal } from '@angular/core';
import type { HomeserverInfo } from '@trinity/data-access/homeserver';
import { NEVER, firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  diagnosticAccounts,
  diagnosticKnownNames,
} from './diagnostic-accounts';

const ALICE = {
  userId: '@alice:example.org',
  deviceId: 'QWERTYUIOP',
  baseUrl: 'https://matrix.example.org',
};
const BOB = {
  userId: '@bob:other.net',
  deviceId: 'ZXCVBNMASD',
  baseUrl: 'https://other.net',
};

function info(
  userId: string,
  software: HomeserverInfo['software'],
): HomeserverInfo {
  return {
    userId,
    serverName: userId.slice(userId.indexOf(':') + 1),
    baseUrl: '',
    discovered: false,
    software,
    specVersions: null,
    unstableFeatures: null,
    capabilities: null,
  };
}

describe('diagnosticAccounts', () => {
  afterEach(() => vi.useRealTimers());

  it('lists accounts active first, with the software their homeserver reports', async () => {
    const sessions = {
      snapshot: () =>
        of({ activeAccountId: BOB.userId, accounts: [ALICE, BOB] }),
    };
    const homeservers = {
      load: vi.fn(() => of(undefined)),
      infos: signal(
        new Map([
          [
            BOB.userId,
            info(BOB.userId, {
              name: 'Synapse',
              version: '1.140.0',
              source: 'base-url',
              host: 'https://other.net',
            }),
          ],
        ]),
      ),
    };

    const accounts = await firstValueFrom(
      diagnosticAccounts(sessions, homeservers),
    );

    expect(accounts).toEqual([
      {
        userId: BOB.userId,
        deviceId: BOB.deviceId,
        homeserverUrl: BOB.baseUrl,
        software: { name: 'Synapse', version: '1.140.0' },
      },
      {
        userId: ALICE.userId,
        deviceId: ALICE.deviceId,
        homeserverUrl: ALICE.baseUrl,
        software: null,
      },
    ]);
    expect(homeservers.load).toHaveBeenCalledTimes(2);
  });

  it('gives up on a homeserver that does not answer within the budget', async () => {
    vi.useFakeTimers();
    const sessions = {
      snapshot: () => of({ activeAccountId: ALICE.userId, accounts: [ALICE] }),
    };
    const homeservers = { load: () => NEVER, infos: signal(new Map()) };

    const pending = firstValueFrom(
      diagnosticAccounts(sessions, homeservers, 3_000),
    );
    await vi.advanceTimersByTimeAsync(3_000);

    expect((await pending)[0].software).toBeNull();
  });

  it('completes with no accounts when none are signed in', async () => {
    const sessions = {
      snapshot: () => of({ activeAccountId: null, accounts: [] }),
    };
    const homeservers = { load: vi.fn(), infos: signal(new Map()) };

    expect(
      await firstValueFrom(diagnosticAccounts(sessions, homeservers)),
    ).toEqual([]);
    expect(homeservers.load).not.toHaveBeenCalled();
  });
});

describe('diagnosticKnownNames', () => {
  const names = {
    alice: {
      roomNames: ['Garden Club', 'Shared Room'],
      roomTopics: ['Roses and tulips'],
      displayNames: ['Alice Liddell', 'Bob Builder'],
    },
    bob: {
      roomNames: ['Shared Room', 'Workshop'],
      roomTopics: [],
      displayNames: ['Bob Builder', 'Wendy'],
    },
  } as const;

  it('gathers the names of every signed-in account, each once', async () => {
    const clients = {
      all: () => [{ client: 'alice' as const }, { client: 'bob' as const }],
    };

    const known = await firstValueFrom(
      diagnosticKnownNames(clients, (client) => names[client]),
    );

    expect(known).toEqual({
      roomNames: ['Garden Club', 'Shared Room', 'Workshop'],
      roomTopics: ['Roses and tulips'],
      displayNames: ['Alice Liddell', 'Bob Builder', 'Wendy'],
    });
  });

  it('reads the clients only when subscribed, at export time', async () => {
    const all = vi.fn(() => [{ client: 'alice' as const }]);
    const read = vi.fn((client: 'alice') => names[client]);

    const known = diagnosticKnownNames({ all }, read);
    expect(all).not.toHaveBeenCalled();

    await firstValueFrom(known);
    await firstValueFrom(known);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('skips an account whose client cannot be read', async () => {
    const clients = {
      all: () => [{ client: 'alice' as const }, { client: 'bob' as const }],
    };

    const known = await firstValueFrom(
      diagnosticKnownNames(clients, (client) => {
        if (client === 'alice') throw new Error('client stopped');
        return names[client];
      }),
    );

    expect(known.roomNames).toEqual(['Shared Room', 'Workshop']);
  });

  it('completes with no names when no account is signed in', async () => {
    expect(
      await firstValueFrom(diagnosticKnownNames({ all: () => [] }, vi.fn())),
    ).toEqual({ roomNames: [], roomTopics: [], displayNames: [] });
  });
});
