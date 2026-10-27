import { effect, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { TestBed } from '@angular/core/testing';
import { finalize, firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SESSION,
  SESSION_ENGINE,
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
  let opened = 0;
  let closed = 0;
  const spaceChildLinks = fake.spaceChildLinks.bind(fake);
  vi.spyOn(fake, 'spaceChildLinks').mockImplementation((accountId, spaceId) => {
    opened += 1;
    return spaceChildLinks(accountId, spaceId).pipe(
      finalize(() => (closed += 1)),
    );
  });
  const setSpaceChild = vi.spyOn(fake, 'setSpaceChild');
  TestBed.configureTestingModule({
    providers: [
      { provide: ROOM_LIST_ENGINE, useValue: fake },
      { provide: SESSION_SNAPSHOT, useValue: session },
      {
        provide: SESSION_ENGINE,
        useFactory: () => ({ session: () => toObservable(session) }),
      },
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
    feeds: () => ({ opened, closed }),
    signIn: () => session.set(signedIn),
    /** The link the nth write sent, as `setSpaceChild` received it. */
    sent: (index = 0) =>
      setSpaceChild.mock.calls[index][3] as Omit<
        SpaceChildLink,
        'childId'
      > | null,
  };
}

/** Every value an effect sees `read` take, starting with the first. */
function frames<T>(read: () => T): T[] {
  const seen: T[] = [];
  TestBed.runInInjectionContext(() => effect(() => seen.push(read())));
  TestBed.tick();
  return seen;
}

describe('SpaceChildrenService', () => {
  describe('linksFor reads', () => {
    it('reads via, suggested and order off each link', () => {
      const { svc } = setup({
        children: [
          { childId: '!a:hs', via: ['a.example'], suggested: true, order: 'm' },
        ],
      });

      expect(svc.linksFor('!s:hs')()).toEqual([
        {
          childId: '!a:hs',
          via: ['a.example'],
          suggested: true,
          order: 'm',
        },
      ]);
    });

    it('drops a removed child, whose link has no via', () => {
      // An empty-content `m.space.child` is the spec's tombstone. Treating it as a live
      // link would list a room the space no longer contains — and offer to curate it.
      const { svc } = setup({
        children: [
          { childId: '!gone:hs', via: [] },
          { childId: '!here:hs', via: ['hs.example'] },
        ],
      });

      expect(
        svc
          .linksFor('!s:hs')()
          .map((l) => l.childId),
      ).toEqual(['!here:hs']);
    });

    it('treats an order the spec rejects as no order at all', () => {
      // Sorting by a key every other client ignores would show this user an arrangement
      // nobody else sees.
      const { svc } = setup({
        children: [{ childId: '!a:hs', order: 'a\nb' }],
      });

      expect(svc.linksFor('!s:hs')()[0].order).toBe('');
    });

    it('sorts by code point and puts unordered children last', () => {
      const { svc } = setup({
        children: [
          { childId: '!none:hs' },
          { childId: '!lower:hs', order: 'a' },
          { childId: '!upper:hs', order: 'B' },
        ],
      });

      // 'B' (66) before 'a' (97) — locale collation would put 'a' first.
      expect(
        svc
          .linksFor('!s:hs')()
          .map((l) => l.childId),
      ).toEqual(['!upper:hs', '!lower:hs', '!none:hs']);
    });

    it('is empty for a space the client does not have', () => {
      const { svc } = setup({ noRoom: true });

      expect(svc.linksFor('!s:hs')()).toEqual([]);
    });
  });

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

    it('drops the flag rather than writing suggested: false', async () => {
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

  describe('linksFor', () => {
    it('seeds from current state before connect', () => {
      const { svc } = setup({ children: [{ childId: '!a:hs' }] });

      // A caller may read this in a field initializer, before anything has connected.
      expect(
        svc
          .linksFor('!s:hs')()
          .map((l) => l.childId),
      ).toEqual(['!a:hs']);
    });

    it('linksFor has no blank first frame', () => {
      const { svc } = setup({ children: [{ childId: '!a:hs' }] });
      const links = svc.linksFor('!s:hs');

      expect(frames(() => links().map((l) => l.childId))).toEqual([['!a:hs']]);
    });

    it('follows a child link added by someone else', () => {
      const { svc, write } = setup({ children: [{ childId: '!a:hs' }] });
      const links = svc.linksFor('!s:hs');
      links();

      // No `order`, so it lands beside !a:hs and sorts by id — this case is about the link
      // being SEEN, and an ordered child would sort ahead of an unordered one.
      write('!s:hs', { childId: '!b:hs' });

      expect(links().map((l) => l.childId)).toEqual(['!a:hs', '!b:hs']);
    });

    it('ignores unrelated state and other rooms', () => {
      const { svc, fake, me, write } = setup({
        children: [{ childId: '!a:hs' }],
      });
      const links = svc.linksFor('!s:hs');
      const before = links();

      fake.setTag(me, '!s:hs', 'favourite', true).subscribe();
      write('!other:hs', { childId: '!b:hs' });

      expect(links()).toBe(before);
    });

    it('collapses a burst of child events into one rebuild', () => {
      const { svc, write } = setup({ children: [{ childId: '!a:hs' }] });
      const links = svc.linksFor('!s:hs');
      const seen = frames(() => links().map((l) => l.childId));

      // A reorder is sent as one state event per sibling, so this is the ordinary case.
      write('!s:hs', { childId: '!b:hs' });
      write('!s:hs', { childId: '!c:hs' });
      write('!s:hs', { childId: '!d:hs' });
      TestBed.tick();

      expect(seen).toEqual([['!a:hs'], ['!a:hs', '!b:hs', '!c:hs', '!d:hs']]);
    });

    it('holds the same array when the state says the same thing', () => {
      const { svc, write } = setup({ children: [{ childId: '!a:hs' }] });
      const links = svc.linksFor('!s:hs');
      const before = links();

      write('!s:hs', { childId: '!a:hs' });

      // Structural equality: a rebuild that changes nothing must not tick consumers.
      expect(links()).toBe(before);
    });

    it('detaches on disconnect and stops re-reading', () => {
      const { svc, session, feeds, write } = setup({
        children: [{ childId: '!a:hs' }],
      });
      const links = svc.linksFor('!s:hs');
      links();

      session.set(EMPTY_SESSION);
      TestBed.tick();
      expect(feeds()).toEqual({ opened: 1, closed: 1 });

      write('!s:hs', { childId: '!b:hs' });

      // Deliberately NOT cleared: an empty list renders as "this space has no rooms",
      // which is a wrong answer rather than a missing one.
      expect(links().map((l) => l.childId)).toEqual(['!a:hs']);
      expect(feeds()).toEqual({ opened: 1, closed: 1 });
    });

    it('shares one signal per space', () => {
      const { svc } = setup({ children: [{ childId: '!a:hs' }] });

      expect(svc.linksFor('!s:hs')).toBe(svc.linksFor('!s:hs'));
    });

    it('fills in a signal created while signed out, once connected', () => {
      // A signal handed out before there is an Account is empty by necessity; it has to
      // fill in once one is live, or a surface built during startup stays blank.
      const { svc, signIn } = setup({
        children: [{ childId: '!a:hs' }],
        signedOut: true,
      });
      const links = svc.linksFor('!s:hs');
      expect(links()).toEqual([]);

      signIn();

      expect(links().map((l) => l.childId)).toEqual(['!a:hs']);
    });

    it('re-seeds every watched space when it rewires onto a new client', () => {
      // A re-login hands the Account a new generation; a signal left on the previous
      // generation's links is the failure this guards.
      const { svc, me, session, feeds, write } = setup({
        children: [{ childId: '!a:hs' }],
      });
      const links = svc.linksFor('!s:hs');
      links();

      session.set({
        ...EMPTY_SESSION,
        activeAccountId: me,
        accounts: [account(me, 2)],
      });
      TestBed.tick();
      write('!s:hs', { childId: '!a:hs', via: [] });
      write('!s:hs', { childId: '!b:hs' });

      expect(links().map((l) => l.childId)).toEqual(['!b:hs']);
      expect(feeds()).toEqual({ opened: 2, closed: 1 });
    });
  });
});
