import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { defineIdentityEngineContract } from './identity-engine.contract';
import { FakeIdentityEngine } from './fake-identity-engine';

const ALICE = '@alice:example.org';
const BOB = '@bob:example.org';

defineIdentityEngineContract(
  () => {
    const engine = new FakeIdentityEngine();
    engine.signIn(ALICE);
    engine.signIn(BOB);
    const knownUser = {
      userId: '@carol:example.org',
      displayName: 'Carol',
      avatarMxc: 'mxc://example.org/c',
    };
    engine.profiles.set(knownUser.userId, knownUser);
    return Promise.resolve({
      engine,
      alice: ALICE,
      bob: BOB,
      unknownUser: '@unknown:example.org',
      knownUser,
      avatars: ['mxc://example.org/a', 'mxc://example.org/b'] as const,
      dispose: () => Promise.resolve(),
    });
  },
  { settleTimeoutMs: 1_000, testTimeoutMs: 5_000 },
);

describe('FakeIdentityEngine', () => {
  it('reports no own presence until the account sets one', async () => {
    const engine = new FakeIdentityEngine();
    engine.signIn(ALICE);

    expect(await firstValueFrom(engine.ownPresence(ALICE))).toEqual({
      ok: true,
      value: { presence: null, statusMessage: null },
    });
  });

  it('answers every command with the scripted failure, changing nothing', async () => {
    const engine = new FakeIdentityEngine();
    engine.signIn(ALICE, { displayName: 'Alice', avatarMxc: null });
    const failure = {
      kind: 'network',
      code: 'request-failed',
      diagnostic: { kind: 'network' },
    } as const;
    engine.failure = failure;

    expect(
      await firstValueFrom(engine.setDisplayName(ALICE, 'Changed')),
    ).toEqual({ ok: false, failure });
    expect(engine.profiles.get(ALICE)?.displayName).toBe('Alice');
  });
});
