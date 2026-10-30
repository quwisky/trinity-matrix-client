import { EventEmitter } from 'events';
import { TestBed } from '@angular/core/testing';
import { RoomEvent, RoomStateEvent, type MatrixClient } from 'matrix-js-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { JsSdkRoomListEngine } from './js-sdk-room-list-engine';

const ME = '@me:hs';
const PERSON = '@bob:hs';
const UNSTABLE_FLAG = 'uk.half-shot.msc2666.query_mutual_rooms';
const STABLE_PATH = '/_matrix/client/v1/mutual_rooms';
const UNSTABLE_PATH =
  '/_matrix/client/unstable/uk.half-shot.msc2666/user/mutual_rooms';

type Page = { joined: string[]; next_batch?: string };

function fakeRoom(
  roomId: string,
  members: Record<string, string> = {},
  membership = 'join',
) {
  const room = {
    roomId,
    members,
    membership,
    getMyMembership: () => room.membership,
    getMember: (userId: string) =>
      members[userId] ? { userId, membership: members[userId] } : null,
  };
  return room;
}

class FakeClient extends EventEmitter {
  /** The `/versions` answer; null never answers. */
  versions: {
    versions: string[];
    unstable_features: Record<string, boolean>;
  } | null = { versions: ['v1.11'], unstable_features: {} };
  /** The mutual-rooms pages in request order, or the error every request fails with. */
  pages: Page[] | Error = [];
  readonly authedRequest = vi.fn(async (): Promise<Page> => {
    if (this.pages instanceof Error) throw this.pages;
    return (
      this.pages[this.authedRequest.mock.calls.length - 1] ?? { joined: [] }
    );
  });
  readonly http = { authedRequest: this.authedRequest };

  constructor(public rooms: ReturnType<typeof fakeRoom>[]) {
    super();
  }

  getRooms = () => this.rooms;
  getVersions = () =>
    this.versions
      ? Promise.resolve(this.versions)
      : new Promise<never>(() => undefined);

  memberChanged(userId: string): void {
    this.emit(RoomStateEvent.Members, {}, {}, { userId });
  }

  totalListeners(): number {
    return this.eventNames().reduce<number>(
      (sum, name) => sum + this.listenerCount(name),
      0,
    );
  }
}

function setup(client: FakeClient) {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: JS_SDK_CLIENTS,
        useValue: {
          clientFor: (id: string) =>
            id === ME ? (client as unknown as MatrixClient) : null,
        },
      },
    ],
  });
  const engine = TestBed.inject(JsSdkRoomListEngine);
  const seen: (readonly string[])[] = [];
  const subscription = engine
    .roomsInCommon(ME, PERSON)
    .subscribe((ids) => seen.push(ids));
  return { engine, seen, subscription, latest: () => seen.at(-1) };
}

/** Lets `/versions` and any mutual-rooms request settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.useRealTimers());

describe('JsSdkRoomListEngine roomsInCommon', () => {
  it('lists joined rooms where the person is joined too', async () => {
    const client = new FakeClient([
      fakeRoom('!a', { [PERSON]: 'join' }),
      fakeRoom('!b', { [PERSON]: 'invite' }),
      fakeRoom('!c', { [PERSON]: 'leave' }),
      fakeRoom('!d', { [PERSON]: 'join' }, 'invite'),
      fakeRoom('!e'),
    ]);
    const { seen } = setup(client);
    await settle();

    expect(seen).toEqual([['!a']]);
  });

  it("follows the person's membership and the account's own, at once", async () => {
    const shared = fakeRoom('!a', { [PERSON]: 'join' });
    const client = new FakeClient([shared]);
    const { latest } = setup(client);
    await settle();

    shared.members[PERSON] = 'leave';
    client.memberChanged('@someone-else:hs');
    expect(latest()).toEqual(['!a']);
    client.memberChanged(PERSON);
    expect(latest()).toEqual([]);

    shared.members[PERSON] = 'join';
    shared.membership = 'leave';
    client.emit(RoomEvent.MyMembership, shared, 'leave');
    expect(latest()).toEqual([]);
    shared.membership = 'join';
    client.emit(RoomEvent.MyMembership, shared, 'join');
    expect(latest()).toEqual(['!a']);
  });

  it('is empty for an account that is not live', () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: JS_SDK_CLIENTS, useValue: { clientFor: () => null } },
      ],
    });
    const seen: unknown[] = [];

    TestBed.inject(JsSdkRoomListEngine)
      .roomsInCommon(ME, PERSON)
      .subscribe((ids) => seen.push(ids));

    expect(seen).toEqual([[]]);
  });

  it('unsubscribing removes its listeners and cancels the server request', async () => {
    const client = new FakeClient([]);
    client.versions = {
      versions: [],
      unstable_features: { [UNSTABLE_FLAG]: true },
    };
    const { subscription } = setup(client);
    expect(client.totalListeners()).toBeGreaterThan(0);

    subscription.unsubscribe();
    await settle();

    expect(client.totalListeners()).toBe(0);
    expect(client.authedRequest).not.toHaveBeenCalled();
  });

  describe('server mutual rooms (MSC2666)', () => {
    it("lists the server's rooms whose roster is not loaded; known membership wins", async () => {
      const client = new FakeClient([
        // Lazy-loaded rosters: the client does not know the person here.
        fakeRoom('!a'),
        fakeRoom('!b'),
        // The client has seen the person leave.
        fakeRoom('!c', { [PERSON]: 'leave' }),
      ]);
      client.versions = {
        versions: [],
        unstable_features: { [UNSTABLE_FLAG]: true },
      };
      client.pages = [{ joined: ['!a', '!c', '!unknown'] }];
      const { seen } = setup(client);
      await settle();

      expect(seen).toEqual([['!a']]);
      expect(client.authedRequest).toHaveBeenCalledWith(
        'GET',
        UNSTABLE_PATH,
        { user_id: PERSON },
        undefined,
        { prefix: '' },
      );
    });

    it('follows next_batch on the stable path', async () => {
      const client = new FakeClient([fakeRoom('!a'), fakeRoom('!b')]);
      client.versions = { versions: ['v1.19'], unstable_features: {} };
      client.pages = [{ joined: ['!a'], next_batch: 't1' }, { joined: ['!b'] }];
      const { latest } = setup(client);
      await settle();

      expect(latest()).toEqual(['!a', '!b']);
      expect(client.authedRequest.mock.calls).toEqual([
        ['GET', STABLE_PATH, { user_id: PERSON }, undefined, { prefix: '' }],
        [
          'GET',
          STABLE_PATH,
          { user_id: PERSON, from: 't1' },
          undefined,
          { prefix: '' },
        ],
      ]);
    });

    it('stops after ten pages', async () => {
      const client = new FakeClient([fakeRoom('!a')]);
      client.versions = { versions: ['v1.19'], unstable_features: {} };
      client.pages = Array.from({ length: 12 }, (_, i) => ({
        joined: [`!${i}`],
        next_batch: `t${i}`,
      }));
      setup(client);
      await settle();

      expect(client.authedRequest).toHaveBeenCalledTimes(10);
    });

    it('reads locally when the server does not advertise it', async () => {
      const client = new FakeClient([
        fakeRoom('!a'),
        fakeRoom('!b', { [PERSON]: 'join' }),
      ]);
      const { seen } = setup(client);
      await settle();

      expect(seen).toEqual([['!b']]);
      expect(client.authedRequest).not.toHaveBeenCalled();
    });

    it('reads locally when the request fails', async () => {
      const client = new FakeClient([
        fakeRoom('!a'),
        fakeRoom('!b', { [PERSON]: 'join' }),
      ]);
      client.versions = {
        versions: [],
        unstable_features: { [UNSTABLE_FLAG]: true },
      };
      client.pages = new Error('404');
      const { seen } = setup(client);
      await settle();

      expect(seen).toEqual([['!b']]);
    });

    it('emits nothing until the server answers, and reads locally after 10 s without one', async () => {
      vi.useFakeTimers();
      const client = new FakeClient([
        fakeRoom('!a'),
        fakeRoom('!b', { [PERSON]: 'join' }),
      ]);
      client.versions = null;
      const { seen } = setup(client);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(seen).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);

      expect(seen).toEqual([['!b']]);
    });

    it('asks again a second after the last membership change', async () => {
      vi.useFakeTimers();
      const client = new FakeClient([fakeRoom('!a'), fakeRoom('!b')]);
      client.versions = {
        versions: [],
        unstable_features: { [UNSTABLE_FLAG]: true },
      };
      client.pages = [{ joined: ['!a'] }, { joined: ['!a', '!b'] }];
      const { latest } = setup(client);
      await vi.advanceTimersByTimeAsync(0);
      expect(latest()).toEqual(['!a']);

      client.memberChanged(PERSON);
      client.emit(RoomEvent.MyMembership, {}, 'join');
      await vi.advanceTimersByTimeAsync(999);
      expect(client.authedRequest).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(client.authedRequest).toHaveBeenCalledTimes(2);
      expect(latest()).toEqual(['!a', '!b']);
    });
  });
});
