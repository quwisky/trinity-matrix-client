import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { SpaceChildrenService } from './space-children.service';
import { compareOrder } from './space-child-order';

interface ChildFixture {
  childId: string;
  via?: string[];
  suggested?: boolean;
  order?: string;
}

function setup(
  opts: {
    children?: ChildFixture[];
    may?: boolean;
    noRoom?: boolean;
    signedOut?: boolean;
  } = {},
) {
  const sendStateEvent = vi.fn().mockResolvedValue({});
  const events = (opts.children ?? []).map((child) => ({
    getStateKey: () => child.childId,
    getContent: () => ({
      ...(child.via === undefined
        ? { via: ['hs.example'] }
        : { via: child.via }),
      ...(child.suggested === undefined ? {} : { suggested: child.suggested }),
      ...(child.order === undefined ? {} : { order: child.order }),
    }),
  }));
  const room = opts.noRoom
    ? null
    : {
        getLiveTimeline: () => ({
          getState: () => ({
            maySendStateEvent: () => opts.may ?? true,
            getStateEvents: (type: string) =>
              type === 'm.space.child' ? events : [],
          }),
        }),
      };
  TestBed.configureTestingModule({
    providers: [
      SpaceChildrenService,
      MockProvider(MatrixClientService, {
        isInitialized: !opts.signedOut,
        instance: {
          sendStateEvent,
          getRoom: () => room,
          getUserId: () => '@me:hs.example',
        } as never,
      }),
    ],
  });
  return { svc: TestBed.inject(SpaceChildrenService), sendStateEvent };
}

/** The content of the nth `sendStateEvent` call. */
function sentContent(
  sendStateEvent: ReturnType<typeof vi.fn>,
  index = 0,
): Record<string, unknown> {
  return sendStateEvent.mock.calls[index][2] as Record<string, unknown>;
}

describe('SpaceChildrenService', () => {
  describe('childLinks', () => {
    it('reads via, suggested and order off each link', () => {
      const { svc } = setup({
        children: [
          { childId: '!a:hs', via: ['a.example'], suggested: true, order: 'm' },
        ],
      });

      expect(svc.childLinks('!s:hs')).toEqual([
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

      expect(svc.childLinks('!s:hs').map((l) => l.childId)).toEqual([
        '!here:hs',
      ]);
    });

    it('treats an order the spec rejects as no order at all', () => {
      // Sorting by a key every other client ignores would show this user an arrangement
      // nobody else sees.
      const { svc } = setup({
        children: [{ childId: '!a:hs', order: 'a\nb' }],
      });

      expect(svc.childLinks('!s:hs')[0].order).toBe('');
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
      expect(svc.childLinks('!s:hs').map((l) => l.childId)).toEqual([
        '!upper:hs',
        '!lower:hs',
        '!none:hs',
      ]);
    });

    it('is empty for a space the client does not have', () => {
      const { svc } = setup({ noRoom: true });

      expect(svc.childLinks('!s:hs')).toEqual([]);
    });
  });

  describe('canCurate', () => {
    it('is true when the user may send m.space.child', () => {
      expect(setup({ may: true }).svc.canCurate('!s:hs')).toBe(true);
    });

    it('is false when the power levels forbid it', () => {
      // Hidden rather than offered-then-rejected: a curation control the server refuses
      // reads as a broken feature.
      expect(setup({ may: false }).svc.canCurate('!s:hs')).toBe(false);
    });

    it('is false when signed out', () => {
      expect(setup({ signedOut: true }).svc.canCurate('!s:hs')).toBe(false);
    });
  });

  describe('addExistingRoom', () => {
    it('links a joined room into the space', async () => {
      const { svc, sendStateEvent } = setup();

      await firstValueFrom(svc.addExistingRoom('!s:hs', '!room:other.example'));

      expect(sendStateEvent).toHaveBeenCalledWith(
        '!s:hs',
        'm.space.child',
        expect.objectContaining({ via: ['other.example'] }),
        '!room:other.example',
      );
    });

    it('routes via the child’s own server, not ours', async () => {
      // A `via` naming only our homeserver is useless for a room we do not host — the
      // point of `via` is to tell a remote server where to find the room.
      const { svc, sendStateEvent } = setup();

      await firstValueFrom(svc.addExistingRoom('!s:hs', '!r:remote.example'));

      expect(sentContent(sendStateEvent)['via']).toEqual(['remote.example']);
    });

    it('appends after the last child rather than disturbing the arrangement', async () => {
      const { svc, sendStateEvent } = setup({
        children: [
          { childId: '!a:hs', order: 'a' },
          { childId: '!b:hs', order: 'b' },
        ],
      });

      await firstValueFrom(svc.addExistingRoom('!s:hs', '!c:hs'));

      const order = sentContent(sendStateEvent)['order'] as string;
      expect(compareOrder('b', order)).toBe(-1);
    });

    it('does not re-link a room that is already a child', async () => {
      // Re-sending would silently reset whatever curation the link carries.
      const { svc, sendStateEvent } = setup({
        children: [{ childId: '!a:hs', suggested: true, order: 'm' }],
      });

      await firstValueFrom(svc.addExistingRoom('!s:hs', '!a:hs'));

      expect(sendStateEvent).not.toHaveBeenCalled();
    });

    it('rejects when signed out', async () => {
      const { svc, sendStateEvent } = setup({ signedOut: true });

      await expect(
        firstValueFrom(svc.addExistingRoom('!s:hs', '!a:hs')),
      ).rejects.toThrow(/not signed in/i);
      expect(sendStateEvent).not.toHaveBeenCalled();
    });
  });

  describe('setSuggested', () => {
    it('keeps via and order when flagging a child', async () => {
      // THE failure this service is built to avoid: state events are replaced, not
      // merged, so a write that dropped `via` would leave the child unroutable for
      // anyone whose homeserver has not already seen it.
      const { svc, sendStateEvent } = setup({
        children: [
          { childId: '!a:hs', via: ['a.example', 'b.example'], order: 'm' },
        ],
      });

      await firstValueFrom(svc.setSuggested('!s:hs', '!a:hs', true));

      expect(sendStateEvent).toHaveBeenCalledWith(
        '!s:hs',
        'm.space.child',
        { via: ['a.example', 'b.example'], suggested: true, order: 'm' },
        '!a:hs',
      );
    });

    it('drops the flag rather than writing suggested: false', async () => {
      const { svc, sendStateEvent } = setup({
        children: [{ childId: '!a:hs', suggested: true }],
      });

      await firstValueFrom(svc.setSuggested('!s:hs', '!a:hs', false));

      expect(sentContent(sendStateEvent)).not.toHaveProperty('suggested');
    });

    it('rejects for a room that is not in the space', async () => {
      const { svc, sendStateEvent } = setup({ children: [] });

      await expect(
        firstValueFrom(svc.setSuggested('!s:hs', '!nope:hs', true)),
      ).rejects.toThrow(/not in this space/i);
      expect(sendStateEvent).not.toHaveBeenCalled();
    });
  });

  describe('moveChildBefore', () => {
    it('moves a child with a single write', async () => {
      const { svc, sendStateEvent } = setup({
        children: [
          { childId: '!a:hs', order: '1' },
          { childId: '!b:hs', order: '5' },
          { childId: '!c:hs', order: '9' },
        ],
      });

      // Put c between a and b.
      await firstValueFrom(svc.moveChildBefore('!s:hs', '!c:hs', '!b:hs'));

      expect(sendStateEvent).toHaveBeenCalledTimes(1);
      const order = sentContent(sendStateEvent)['order'] as string;
      expect(compareOrder('1', order)).toBe(-1);
      expect(compareOrder(order, '5')).toBe(-1);
    });

    it('preserves via while reordering', async () => {
      const { svc, sendStateEvent } = setup({
        children: [
          { childId: '!a:hs', via: ['a.example'], order: '1' },
          { childId: '!b:hs', via: ['b.example'], order: '9' },
        ],
      });

      await firstValueFrom(svc.moveChildBefore('!s:hs', '!b:hs', '!a:hs'));

      expect(sentContent(sendStateEvent)['via']).toEqual(['b.example']);
    });

    it('moves a child to the end when there is nothing to sit before', async () => {
      const { svc, sendStateEvent } = setup({
        children: [
          { childId: '!a:hs', order: '1' },
          { childId: '!b:hs', order: '5' },
        ],
      });

      await firstValueFrom(svc.moveChildBefore('!s:hs', '!a:hs', null));

      const order = sentContent(sendStateEvent)['order'] as string;
      expect(compareOrder('5', order)).toBe(-1);
    });

    it('renumbers the siblings when no key fits between them', async () => {
      // '0' and '00' are adjacent with nothing between, so a single write cannot express
      // the move. Renumbering is several writes but is the only way to make room.
      const { svc, sendStateEvent } = setup({
        children: [
          { childId: '!a:hs', order: '0' },
          { childId: '!b:hs', order: '00' },
          { childId: '!c:hs', order: '9' },
        ],
      });

      await firstValueFrom(svc.moveChildBefore('!s:hs', '!c:hs', '!b:hs'));

      expect(sendStateEvent.mock.calls.length).toBeGreaterThan(1);
      // Whatever it wrote, the resulting arrangement must be a, c, b.
      const written = new Map(
        sendStateEvent.mock.calls.map((call) => [
          call[3] as string,
          (call[2] as Record<string, unknown>)['order'] as string,
        ]),
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
      const { svc, sendStateEvent } = setup({
        children: [{ childId: '!a:hs', order: '1' }],
      });

      await expect(
        firstValueFrom(svc.moveChildBefore('!s:hs', '!nope:hs', null)),
      ).rejects.toThrow(/not in this space/i);
      expect(sendStateEvent).not.toHaveBeenCalled();
    });

    it('rejects moving before a room that is not in the space', async () => {
      const { svc, sendStateEvent } = setup({
        children: [{ childId: '!a:hs', order: '1' }],
      });

      await expect(
        firstValueFrom(svc.moveChildBefore('!s:hs', '!a:hs', '!nope:hs')),
      ).rejects.toThrow(/not in this space/i);
      expect(sendStateEvent).not.toHaveBeenCalled();
    });
  });
});
