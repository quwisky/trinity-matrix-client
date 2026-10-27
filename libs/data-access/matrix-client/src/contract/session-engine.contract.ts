import {
  type Observable,
  filter,
  firstValueFrom,
  take,
  timeout,
  toArray,
} from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type MatrixSession, assertPlainData } from '@trinity/util/matrix';
import {
  EMPTY_SESSION,
  type SessionEngine,
  type SessionSnapshot,
} from '../lib/session-engine';

export interface SessionContractSetup {
  readonly engine: SessionEngine;
  /** A password session for a fresh account. */
  newSession(): Promise<MatrixSession>;
  /** Whether the server still accepts the session's token (whoami). */
  tokenAccepted(session: MatrixSession): Promise<boolean>;
  dispose(): Promise<void>;
}

const NOBODY = '@nobody:invalid';

export function defineSessionEngineContract(
  setup: () => Promise<SessionContractSetup>,
): void {
  describe('SessionEngine contract', () => {
    let context: SessionContractSetup;
    let engine: SessionEngine;

    // A live Synapse needs time to register accounts.
    beforeEach(async () => {
      context = await setup();
      engine = context.engine;
    }, 120_000);

    afterEach(async () => {
      try {
        await once(engine.stop());
      } finally {
        await context.dispose();
      }
    }, 60_000);

    /** Asserts the command emits exactly once with plain data, and returns that value. */
    async function once<T>(source: Observable<T>): Promise<T> {
      const emitted = await firstValueFrom(source.pipe(toArray()));
      expect(emitted).toHaveLength(1);
      expect(() => assertPlainData(emitted[0])).not.toThrow();
      return emitted[0];
    }

    /** The first `session()` emission, which must be the current snapshot. */
    async function snapshot(): Promise<SessionSnapshot> {
      const first = await firstValueFrom(engine.session().pipe(take(1)));
      expect(() => assertPlainData(first)).not.toThrow();
      return first;
    }

    async function restore(
      session: MatrixSession,
      activation: 'activate' | 'background' = 'activate',
    ): Promise<void> {
      await expect(
        once(engine.restorePersisted(session, activation)),
      ).resolves.toEqual({ ok: true, value: null });
    }

    it('starts empty', async () => {
      await expect(snapshot()).resolves.toEqual(EMPTY_SESSION);
    });

    it('restores an account and makes it active', async () => {
      const s = await context.newSession();

      await restore(s);

      const first = await snapshot();
      expect(first.activeAccountId).toBe(s.userId);
      expect(first.accounts).toHaveLength(1);
      expect(JSON.stringify(first)).not.toContain(s.accessToken);
      const synced = await firstValueFrom(
        engine.session().pipe(
          filter((x) =>
            x.accounts.every((a) => a.serverSynced && a.roomsPrepared),
          ),
          timeout(30_000),
        ),
      );
      expect(['prepared', 'syncing']).toContain(synced.accounts[0].syncState);
    }, 60_000);

    it('restores in the background without changing the active account', async () => {
      const a = await context.newSession();
      const b = await context.newSession();

      await restore(a);
      await restore(b, 'background');

      const first = await snapshot();
      expect(first.activeAccountId).toBe(a.userId);
      expect(first.accounts.map((x) => x.accountId)).toEqual([
        a.userId,
        b.userId,
      ]);
    }, 60_000);

    it('switches between live accounts and ignores unknown ones', async () => {
      const a = await context.newSession();
      const b = await context.newSession();
      await restore(a);
      await restore(b, 'background');

      await once(engine.setActive(b.userId));
      expect((await snapshot()).activeAccountId).toBe(b.userId);

      await once(engine.setActive(NOBODY));
      expect((await snapshot()).activeAccountId).toBe(b.userId);
    }, 60_000);

    it('activates with replace and retires the others', async () => {
      const a = await context.newSession();
      const b = await context.newSession();
      await restore(a);
      await restore(b, 'background');

      await expect(
        once(engine.activateAccount(a.userId, 'replace')),
      ).resolves.toEqual({ ok: true, value: null });

      const after = await snapshot();
      expect(after.accounts.map((x) => x.accountId)).toEqual([a.userId]);
      expect(after.activeAccountId).toBe(a.userId);

      const missing = await once(engine.activateAccount(NOBODY, 'keep'));
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(missing.failure.code).toBe('account-not-live');
    }, 60_000);

    it('rolls back a start without losing the account', async () => {
      const a = await context.newSession();
      await restore(a);

      await once(engine.rollbackAccountStart(a.userId));
      expect((await snapshot()).accounts).toEqual([]);

      await restore(a);
      expect((await snapshot()).activeAccountId).toBe(a.userId);
    }, 60_000);

    it('removes one account and repoints the active one', async () => {
      const a = await context.newSession();
      const b = await context.newSession();
      await restore(a);
      await restore(b);

      await once(engine.remove(b.userId));

      const after = await snapshot();
      expect(after.accounts.map((x) => x.accountId)).toEqual([a.userId]);
      expect(after.activeAccountId).toBe(a.userId);
    }, 60_000);

    it('keeps commands cold', async () => {
      const a = await context.newSession();
      const b = await context.newSession();
      await restore(a);
      await restore(b, 'background');

      engine.setActive(b.userId);

      expect((await snapshot()).activeAccountId).toBe(a.userId);
    }, 60_000);

    it('reports the account token and server status', async () => {
      const s = await context.newSession();
      await restore(s);

      await expect(
        firstValueFrom(engine.accessToken(s.userId)),
      ).resolves.toEqual({
        accessToken: s.accessToken,
        expiresAt: null,
        refreshable: false,
      });
      await expect(
        firstValueFrom(engine.accessToken(NOBODY)),
      ).resolves.toBeNull();
      await expect(once(engine.accountStatus(s.userId))).resolves.toBe(
        'active',
      );
      await expect(once(engine.accountStatus(NOBODY))).resolves.toBe(
        'unreachable',
      );
      await expect(once(engine.roomKeysBackedUp(NOBODY))).resolves.toBeNull();
      await expect(once(engine.refreshAccessToken(s.userId, {}))).resolves.toBe(
        false,
      );
    }, 60_000);

    it('has no outgoing work when idle', async () => {
      const s = await context.newSession();
      await restore(s);

      await expect(once(engine.hasOutgoingWork())).resolves.toBe(false);
      await expect(once(engine.pendingTextMessages())).resolves.toEqual([]);
      await expect(once(engine.pauseSync())).resolves.toBeNull();
    }, 60_000);

    it('signs every live account out on the server', async () => {
      const a = await context.newSession();
      const b = await context.newSession();
      await restore(a);
      await restore(b, 'background');

      await expect(once(engine.signOutAll())).resolves.toBeNull();

      await expect(context.tokenAccepted(a)).resolves.toBe(false);
      await expect(context.tokenAccepted(b)).resolves.toBe(false);
    }, 60_000);

    it('stops everything', async () => {
      const s = await context.newSession();
      await restore(s);

      await expect(once(engine.stop())).resolves.toBeNull();

      await expect(snapshot()).resolves.toEqual(EMPTY_SESSION);
    }, 60_000);
  });
}
