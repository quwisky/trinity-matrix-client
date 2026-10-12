import { signal } from '@angular/core';
import type { HomeserverInfo } from '@trinity/data-access/homeserver';
import { NEVER, firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diagnosticAccounts } from './diagnostic-accounts';

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
