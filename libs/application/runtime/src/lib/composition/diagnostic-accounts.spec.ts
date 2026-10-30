import { signal } from '@angular/core';
import type { HomeserverInfo } from '@trinity/data-access/homeserver';
import {
  type AccountNameGroup,
  EMPTY_SESSION,
  type SessionAccountStatus,
  type SessionEngine,
} from '@trinity/data-access/matrix-client';
import { type EngineFailure, engineFail, engineOk } from '@trinity/util/matrix';
import { NEVER, firstValueFrom, of, throwError } from 'rxjs';
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
  const groups: Readonly<Record<string, readonly AccountNameGroup[]>> = {
    alice: [
      {
        roomNames: ['Garden Club'],
        roomTopics: ['Roses and tulips'],
        displayNames: ['Alice Liddell'],
      },
    ],
    bob: [{ roomNames: ['Workshop'], roomTopics: [], displayNames: ['Wendy'] }],
  };
  const NOT_LIVE: EngineFailure = {
    kind: 'unexpected',
    code: 'account-not-live',
    diagnostic: { kind: 'unexpected' },
  };

  /** An engine whose live accounts, in registry order, read `knownNames`. */
  function engine(
    accountIds: readonly string[],
    knownNames: SessionEngine['knownNames'] = (accountId) =>
      of(engineOk(groups[accountId])),
  ) {
    return {
      session: vi.fn(() =>
        of({
          ...EMPTY_SESSION,
          accounts: accountIds.map(
            (accountId) => ({ accountId }) as SessionAccountStatus,
          ),
        }),
      ),
      knownNames: vi.fn(knownNames),
    };
  }

  it('reads the names of every live account, in registry order', async () => {
    const names = await firstValueFrom(
      diagnosticKnownNames(engine(['alice', 'bob'])),
    );

    expect([...names]).toEqual([...groups['alice'], ...groups['bob']]);
  });

  it('reads the engine only when subscribed', () => {
    const source = engine(['alice']);

    diagnosticKnownNames(source);

    expect(source.knownNames).not.toHaveBeenCalled();
  });

  it('reads every other account when one fails, then reports the failure', async () => {
    const source = engine(['alice', 'bob', 'carol'], (accountId) =>
      accountId === 'alice'
        ? of(engineFail(NOT_LIVE))
        : accountId === 'carol'
          ? throwError(() => new Error('client stopped'))
          : of(engineOk(groups[accountId])),
    );
    const names = await firstValueFrom(diagnosticKnownNames(source));

    // Each pass reads the same names and reports the same failure.
    for (let pass = 0; pass < 2; pass++) {
      const seen: unknown[] = [];
      expect(() => {
        for (const group of names) {
          seen.push(group);
        }
      }).toThrow(
        expect.objectContaining({
          message: 'The names of some accounts could not be read.',
          cause: NOT_LIVE,
        }),
      );
      expect(seen).toEqual(groups['bob']);
    }
  });

  it('reads nothing when no account is live', async () => {
    const source = engine([]);

    const names = await firstValueFrom(diagnosticKnownNames(source));

    expect([...names]).toEqual([]);
    expect(source.knownNames).not.toHaveBeenCalled();
  });
});
