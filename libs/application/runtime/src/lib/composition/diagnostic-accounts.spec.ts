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
  const groups = {
    alice: [
      {
        roomNames: ['Garden Club'],
        roomTopics: ['Roses and tulips'],
        displayNames: ['Alice Liddell'],
      },
    ],
    bob: [{ roomNames: ['Workshop'], roomTopics: [], displayNames: ['Wendy'] }],
  } as const;

  it('reads the names of every signed-in account, group by group', () => {
    const clients = {
      all: () => [{ client: 'alice' as const }, { client: 'bob' as const }],
    };

    expect([
      ...diagnosticKnownNames(clients, (client) => groups[client]),
    ]).toEqual([...groups.alice, ...groups.bob]);
  });

  it('reads the clients only when iterated, at export time', () => {
    const all = vi.fn(() => [{ client: 'alice' as const }]);
    const read = vi.fn((client: 'alice') => groups[client]);

    const names = diagnosticKnownNames({ all }, read);
    expect(all).not.toHaveBeenCalled();

    expect([...names]).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads every other account when one fails, then reports the failure', () => {
    const clients = {
      all: () => [{ client: 'alice' as const }, { client: 'bob' as const }],
    };
    const read = function* (client: 'alice' | 'bob') {
      yield* groups[client];
      if (client === 'alice') {
        throw new Error('client stopped');
      }
    };
    const seen: unknown[] = [];

    expect(() => {
      for (const group of diagnosticKnownNames(clients, read)) {
        seen.push(group);
      }
    }).toThrow('could not be read');
    expect(seen).toEqual([...groups.alice, ...groups.bob]);
  });

  it('reads nothing when no account is signed in', () => {
    expect([...diagnosticKnownNames({ all: () => [] }, vi.fn())]).toEqual([]);
  });
});
