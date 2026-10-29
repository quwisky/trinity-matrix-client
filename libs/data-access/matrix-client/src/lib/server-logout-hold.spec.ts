import { NEVER, Subject, firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { FakeSessionEngine } from '../contract/fake-session-engine';
import type { ServerLogoutHoldUpdate, SessionEngine } from './session-engine';
import { type ServerLogoutHold, serverLogoutHold } from './server-logout-hold';

const SESSION = {
  baseUrl: 'https://hs.example',
  userId: '@me:hs',
  deviceId: 'DEV',
  accessToken: 'tok',
};

async function liveEngine() {
  const engine = new FakeSessionEngine();
  await firstValueFrom(engine.restorePersisted(SESSION, 'activate'));
  return engine;
}

describe('serverLogoutHold', () => {
  it('knows of a dead token as soon as the engine reports it', async () => {
    const engine = await liveEngine();
    const onTokenDied = vi.fn();
    const hold = await firstValueFrom(
      serverLogoutHold(engine, SESSION.userId, { onTokenDied }),
    );
    expect(hold.tokenDied()).toBe(false);
    engine.revokedTokens.add(SESSION.accessToken);

    let diedAtResult = false;
    engine
      .deactivateAccount(SESSION.userId, false, null)
      .subscribe(() => (diedAtResult = hold.tokenDied()));

    expect(diedAtResult).toBe(true);
    expect(onTokenDied).toHaveBeenCalledOnce();
    expect(hold.isHeld()).toBe(true);
  });

  it('starts from a token that died before it was taken', async () => {
    const engine = await liveEngine();
    await firstValueFrom(serverLogoutHold(engine, SESSION.userId));
    engine.revokedTokens.add(SESSION.accessToken);
    await firstValueFrom(engine.deactivateAccount(SESSION.userId, false, null));

    const later = await firstValueFrom(
      serverLogoutHold(engine, SESSION.userId),
    );

    expect(later.tokenDied()).toBe(true);
  });

  it('releases once, through the engine', async () => {
    const engine = await liveEngine();
    const hold = await firstValueFrom(serverLogoutHold(engine, SESSION.userId));

    hold.release({ deleted: true });
    hold.release({ deleted: false });

    expect(hold.isHeld()).toBe(false);
    expect(
      engine.calls.filter((c) => c.startsWith('releaseServerLogoutHold')),
    ).toEqual(['releaseServerLogoutHold:hold-1:true']);
  });

  it('stops being held when the account leaves', async () => {
    const engine = await liveEngine();
    const hold = await firstValueFrom(serverLogoutHold(engine, SESSION.userId));

    await firstValueFrom(engine.remove(SESSION.userId));

    expect(hold.isHeld()).toBe(false);
  });

  it('follows a renewed token and a sign-in again', async () => {
    const updates = new Subject<ServerLogoutHoldUpdate>();
    const engine = {
      holdServerLogout: () => updates,
      releaseServerLogoutHold: vi.fn(() => NEVER),
    } as unknown as SessionEngine;
    const onSignedInAgain = vi.fn();
    let hold: ServerLogoutHold | undefined;
    serverLogoutHold(engine, SESSION.userId, { onSignedInAgain }).subscribe(
      (h) => (hold = h),
    );
    updates.next({ kind: 'held', holdId: 'h', tokenDied: true });
    expect(hold?.tokenDied()).toBe(true);

    updates.next({ kind: 'token-renewed' });
    updates.next({ kind: 'signed-in-again' });

    expect(hold?.tokenDied()).toBe(false);
    expect(onSignedInAgain).toHaveBeenCalledOnce();
  });

  it('lets go of a hold dropped before the engine confirmed it', () => {
    const updates = new Subject<ServerLogoutHoldUpdate>();
    const engine = {
      holdServerLogout: () => updates,
    } as unknown as SessionEngine;

    serverLogoutHold(engine, SESSION.userId).subscribe().unsubscribe();

    expect(updates.observed).toBe(false);
  });
});
