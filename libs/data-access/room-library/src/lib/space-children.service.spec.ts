import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SESSION,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import {
  FakeRoomListEngine,
  fakeRoom,
} from '../contract/fake-room-list-engine';
import { ROOM_LIBRARY_GOVERNANCE_POLICY } from './room-library-governance-policy';
import type { SpaceChildLink } from './room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';
import { SpaceChildrenService } from './space-children.service';
import { compareOrder } from './space-child-order';

interface ChildFixture {
  childId: string;
  via?: string[];
  suggested?: boolean;
  order?: string;
}

function account(accountId: string, generation = 1): SessionAccountStatus {
  return {
    accountId,
    deviceId: 'DEVICE',
    generation,
    syncState: 'syncing',
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

/** SpaceChildrenService over the fake engine, with `!s:hs` a space alice has joined. */
function setup(
  opts: {
    children?: ChildFixture[];
    noRoom?: boolean;
    signedOut?: boolean;
  } = {},
) {
  const fake = new FakeRoomListEngine();
  const me = fake.alice;
  fake.seed(
    me,
    opts.noRoom
      ? []
      : [
          fakeRoom('!s:hs', { isSpace: true }),
          fakeRoom('!other:hs', { isSpace: true }),
        ],
  );
  const write = (spaceId: string, child: ChildFixture): void => {
    fake
      .setSpaceChild(me, spaceId, child.childId, {
        via: child.via ?? ['hs.example'],
        suggested: child.suggested ?? false,
        order: child.order ?? '',
      })
      .subscribe();
  };
  for (const child of opts.children ?? []) write('!s:hs', child);
  const signedIn: SessionSnapshot = {
    ...EMPTY_SESSION,
    activeAccountId: me,
    accounts: [account(me)],
  };
  const session = signal<SessionSnapshot>(
    opts.signedOut ? EMPTY_SESSION : signedIn,
  );
  const setSpaceChild = vi.spyOn(fake, 'setSpaceChild');
  TestBed.configureTestingModule({
    providers: [
      { provide: ROOM_LIST_ENGINE, useValue: fake },
      { provide: SESSION_SNAPSHOT, useValue: session },
      {
        provide: ROOM_LIBRARY_GOVERNANCE_POLICY,
        useValue: { authorize: vi.fn(() => ({ kind: 'allowed' as const })) },
      },
    ],
  });
  return {
    svc: TestBed.inject(SpaceChildrenService),
    fake,
    me,
    session,
    setSpaceChild,
    write,
    signIn: () => session.set(signedIn),
    /** The link the nth write sent, as `setSpaceChild` received it. */
    sent: (index = 0) =>
      setSpaceChild.mock.calls[index][3] as Omit<
        SpaceChildLink,
        'childId'
      > | null,
  };
}

describe('SpaceChildrenService', () => {
  describe('addExistingRoom', () => {
    it('links a joined room into the space', async () => {
      const { svc, me, setSpaceChild } = setup();

      await firstValueFrom(
        svc.addExistingRoom(me, '!s:hs', '!room:other.example'),
      );

      expect(setSpaceChild).toHaveBeenCalledWith(
        me,
        '!s:hs',
        '!room:other.example',
        expect.objectContaining({ via: ['other.example'] }),
      );
    });

    it('routes via the child’s own server, not ours', async () => {
      // A `via` naming only our homeserver is useless for a room we do not host — the
      // point of `via` is to tell a remote server where to find the room.
      const { svc, me, sent } = setup();

      await firstValueFrom(
        svc.addExistingRoom(me, '!s:hs', '!r:remote.example'),
      );

      expect(sent()?.via).toEqual(['remote.example']);
    });

    it('appends after the last child rather than disturbing the arrangement', async () => {
      const { svc, me, setSpaceChild, sent } = setup({
        children: [
          { childId: '!a:hs', order: 'a' },
          { childId: '!b:hs', order: 'b' },
        ],
      });
      setSpaceChild.mockClear();

      await firstValueFrom(svc.addExistingRoom(me, '!s:hs', '!c:hs'));

      expect(compareOrder('b', sent()?.order ?? '')).toBe(-1);
    });

    it('does not re-link a room that is already a child', async () => {
      // Re-sending would silently reset whatever curation the link carries.
      const { svc, me, setSpaceChild } = setup({
        children: [{ childId: '!a:hs', suggested: true, order: 'm' }],
      });
      setSpaceChild.mockClear();

      await firstValueFrom(svc.addExistingRoom(me, '!s:hs', '!a:hs'));

      expect(setSpaceChild).not.toHaveBeenCalled();
    });

    it('rejects when signed out', async () => {
      const { svc, me, setSpaceChild } = setup({ signedOut: true });

      await expect(
        firstValueFrom(svc.addExistingRoom(me, '!s:hs', '!a:hs')),
      ).rejects.toThrow(/not signed in/i);
      expect(setSpaceChild).not.toHaveBeenCalled();
    });

    it('maps an Account the engine no longer runs to the same refusal', async () => {
      const { svc, fake, me } = setup();
      fake.failNext('account-not-live');

      await expect(
        firstValueFrom(svc.addExistingRoom(me, '!s:hs', '!a:hs')),
      ).rejects.toThrow(/not signed in/i);
    });
  });

  describe('removeExistingRoom', () => {
    it('writes only the parent tombstone for the exact Account', async () => {
      const { svc, me, setSpaceChild } = setup();

      await firstValueFrom(svc.removeExistingRoom(me, '!s:hs', '!child:hs'));

      expect(setSpaceChild).toHaveBeenCalledWith(
        me,
        '!s:hs',
        '!child:hs',
        null,
      );
    });

    it('does not fall through to the active Account when the target is gone', async () => {
      const { svc, me, setSpaceChild } = setup({ signedOut: true });

      await expect(
        firstValueFrom(svc.removeExistingRoom(me, '!s:hs', '!child:hs')),
      ).rejects.toThrow(/account unavailable/i);
      expect(setSpaceChild).not.toHaveBeenCalled();
    });
  });

  describe('setSuggested', () => {
    it('keeps via and order when flagging a child', async () => {
      // THE failure this service is built to avoid: state events are replaced, not
      // merged, so a write that dropped `via` would leave the child unroutable for
      // anyone whose homeserver has not already seen it.
      const { svc, me, setSpaceChild } = setup({
        children: [
          { childId: '!a:hs', via: ['a.example', 'b.example'], order: 'm' },
        ],
      });
      setSpaceChild.mockClear();

      await firstValueFrom(svc.setSuggested(me, '!s:hs', '!a:hs', true));

      expect(setSpaceChild).toHaveBeenCalledWith(me, '!s:hs', '!a:hs', {
        via: ['a.example', 'b.example'],
        suggested: true,
        order: 'm',
      });
    });

    it('passes suggested: false; the engine omits it', async () => {
      // The engine omits a false `suggested` from the event content.
      const { svc, me, setSpaceChild, sent } = setup({
        children: [{ childId: '!a:hs', suggested: true }],
      });
      setSpaceChild.mockClear();

      await firstValueFrom(svc.setSuggested(me, '!s:hs', '!a:hs', false));

      expect(sent()?.suggested).toBe(false);
    });

    it('rejects for a room that is not in the space', async () => {
      const { svc, me, setSpaceChild } = setup({ children: [] });

      await expect(
        firstValueFrom(svc.setSuggested(me, '!s:hs', '!nope:hs', true)),
      ).rejects.toThrow(/not in this space/i);
      expect(setSpaceChild).not.toHaveBeenCalled();
    });

    it('does not fall through to the active Account when the target is gone', async () => {
      const { svc, me, setSpaceChild } = setup({
        signedOut: true,
        children: [{ childId: '!a:hs' }],
      });
      setSpaceChild.mockClear();

      await expect(
        firstValueFrom(svc.setSuggested(me, '!s:hs', '!a:hs', true)),
      ).rejects.toThrow(/account unavailable/i);
      expect(setSpaceChild).not.toHaveBeenCalled();
    });
  });

  describe('moveChildBefore', () => {
    it('moves a child with a single write', async () => {
      const { svc, me, setSpaceChild, sent } = setup({
        children: [
          { childId: '!a:hs', order: '1' },
          { childId: '!b:hs', order: '5' },
          { childId: '!c:hs', order: '9' },
        ],
      });
      setSpaceChild.mockClear();

      // Put c between a and b.
      await firstValueFrom(svc.moveChildBefore(me, '!s:hs', '!c:hs', '!b:hs'));

      expect(setSpaceChild).toHaveBeenCalledTimes(1);
      const order = sent()?.order ?? '';
      expect(compareOrder('1', order)).toBe(-1);
      expect(compareOrder(order, '5')).toBe(-1);
    });

    it('preserves via while reordering', async () => {
      const { svc, me, setSpaceChild, sent } = setup({
        children: [
          { childId: '!a:hs', via: ['a.example'], order: '1' },
          { childId: '!b:hs', via: ['b.example'], order: '9' },
        ],
      });
      setSpaceChild.mockClear();

      await firstValueFrom(svc.moveChildBefore(me, '!s:hs', '!b:hs', '!a:hs'));

      expect(sent()?.via).toEqual(['b.example']);
    });

    it('moves a child to the end when there is nothing to sit before', async () => {
      const { svc, me, setSpaceChild, sent } = setup({
        children: [
          { childId: '!a:hs', order: '1' },
          { childId: '!b:hs', order: '5' },
        ],
      });
      setSpaceChild.mockClear();

      await firstValueFrom(svc.moveChildBefore(me, '!s:hs', '!a:hs', null));

      expect(compareOrder('5', sent()?.order ?? '')).toBe(-1);
    });

    it('renumbers the siblings when no key fits between them', async () => {
      // '0' and '00' are adjacent with nothing between, so a single write cannot express
      // the move. Renumbering is several writes but is the only way to make room.
      const { svc, me, setSpaceChild } = setup({
        children: [
          { childId: '!a:hs', order: '0' },
          { childId: '!b:hs', order: '00' },
          { childId: '!c:hs', order: '9' },
        ],
      });
      setSpaceChild.mockClear();

      const receipt = await firstValueFrom(
        svc.moveChildBefore(me, '!s:hs', '!c:hs', '!b:hs'),
      );

      expect(setSpaceChild.mock.calls.length).toBeGreaterThan(1);
      // One event per sibling, in the order they end up in.
      expect(setSpaceChild.mock.calls.map((call) => call[2])).toEqual([
        '!a:hs',
        '!c:hs',
        '!b:hs',
      ]);
      expect(receipt.expectedLinks.map(({ childId }) => childId)).toEqual([
        '!a:hs',
        '!c:hs',
        '!b:hs',
      ]);
      // Whatever it wrote, the resulting arrangement must be a, c, b.
      const written = new Map(
        setSpaceChild.mock.calls.map((call) => [call[2], call[3]?.order]),
      );
      const finalOrder = ['!a:hs', '!c:hs', '!b:hs'].map((id) =>
        written.get(id),
      );
      expect(finalOrder.every((order) => typeof order === 'string')).toBe(true);
      expect(
        compareOrder(finalOrder[0] as string, finalOrder[1] as string),
      ).toBe(-1);
      expect(
        compareOrder(finalOrder[1] as string, finalOrder[2] as string),
      ).toBe(-1);
    });

    it('rejects moving a room that is not in the space', async () => {
      const { svc, me, setSpaceChild } = setup({
        children: [{ childId: '!a:hs', order: '1' }],
      });
      setSpaceChild.mockClear();

      await expect(
        firstValueFrom(svc.moveChildBefore(me, '!s:hs', '!nope:hs', null)),
      ).rejects.toThrow(/not in this space/i);
      expect(setSpaceChild).not.toHaveBeenCalled();
    });

    it('rejects moving before a room that is not in the space', async () => {
      const { svc, me, setSpaceChild } = setup({
        children: [{ childId: '!a:hs', order: '1' }],
      });
      setSpaceChild.mockClear();

      await expect(
        firstValueFrom(svc.moveChildBefore(me, '!s:hs', '!a:hs', '!nope:hs')),
      ).rejects.toThrow(/not in this space/i);
      expect(setSpaceChild).not.toHaveBeenCalled();
    });

    it('does not reorder through the active Account when the target is gone', async () => {
      const { svc, me, setSpaceChild } = setup({
        signedOut: true,
        children: [{ childId: '!a:hs' }],
      });
      setSpaceChild.mockClear();

      await expect(
        firstValueFrom(svc.moveChildBefore(me, '!s:hs', '!a:hs', null)),
      ).rejects.toThrow(/account unavailable/i);
      expect(setSpaceChild).not.toHaveBeenCalled();
    });
  });
});
