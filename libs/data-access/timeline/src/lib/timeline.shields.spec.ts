import { TestBed } from '@angular/core/testing';
import {
  EventShieldColour,
  EventShieldReason,
} from 'matrix-js-sdk/lib/crypto-api';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import { TimelineService } from './timeline.service';
import {
  fakeEdit,
  fakeEvent,
  matrixProvider,
  privacyProvider,
} from './timeline.spec-harness';

// The fake clients here model one page of history as `client.scrollback`. The real paging
// (and its race with gappy syncs) is covered against the SDK in live-scrollback.spec.
vi.mock('./live-scrollback', () => ({
  scrollbackLive: async (
    client: { scrollback: (room: unknown, limit: number) => Promise<unknown> },
    room: unknown,
    limit: number,
  ) => {
    await client.scrollback(room, limit);
  },
}));

beforeEach(() => {
  TestBed.configureTestingModule({ providers: [privacyProvider(true)] });
});

beforeEach(() => {
  // Viewing a room = the window is focused (the normal case). markRead only acks
  // while focused; the unfocused / refocus paths are exercised explicitly below.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe('per-message authenticity shields', () => {
  function shieldClient(
    events: ReturnType<typeof fakeEvent>[],
    getEncryptionInfoForEvent: Mock,
    roomEncrypted = false,
    storeEncrypted = false,
    encryptionTs?: number,
  ) {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const room = {
      roomId: '!r:hs',
      hasEncryptionStateEvent: () => roomEncrypted,
      loadMembersIfNeeded: () => Promise.resolve(true),
      getLiveTimeline: () => ({
        getEvents: () => events,
        getPaginationToken: () => null,
        // The room's current `m.room.encryption` state event, dated `encryptionTs`.
        getState: () =>
          encryptionTs === undefined
            ? undefined
            : {
                getStateEvents: (type: string) =>
                  type === 'm.room.encryption'
                    ? { getTs: () => encryptionTs }
                    : null,
              },
      }),
      getMember: () => ({ name: 'A', getMxcAvatarUrl: () => null }),
      relations: { getChildEventsForEvent: () => undefined },
      on: (event: string, handler: (...a: unknown[]) => void) => {
        handlers.set(`room:${event}`, handler);
      },
      off: () => {},
    };
    return {
      baseUrl: 'https://hs',
      handlers,
      getRoom: () => room,
      getUserId: () => '@me:hs',
      on: (event: string, handler: (...a: unknown[]) => void) => {
        handlers.set(`client:${event}`, handler);
      },
      off: () => {},
      sendReadReceipt: () => Promise.resolve({}),
      setRoomReadMarkers: () => Promise.resolve({}),
      getCrypto: () => ({
        getEncryptionInfoForEvent,
        isEncryptionEnabledInRoom: () => Promise.resolve(storeEncrypted),
      }),
      scrollback: () => Promise.resolve(room),
    };
  }

  function openWithShield(getEncryptionInfoForEvent: Mock, encrypted = true) {
    return openWithEvents(
      getEncryptionInfoForEvent,
      [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi', encrypted })],
      false,
    );
  }

  function openWithEvents(
    getEncryptionInfoForEvent: Mock,
    events: ReturnType<typeof fakeEvent>[],
    roomEncrypted: boolean,
    storeEncrypted = false,
    encryptionTs?: number,
  ) {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const client = shieldClient(
      events,
      getEncryptionInfoForEvent,
      roomEncrypted,
      storeEncrypted,
      encryptionTs,
    );
    TestBed.configureTestingModule({
      providers: [TimelineService, matrixProvider(client)],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');
    return { svc, handlers: client.handlers };
  }

  it('projects a grey shield for an unverified-device message', async () => {
    const getInfo = vi.fn().mockResolvedValue({
      shieldColour: EventShieldColour.GREY,
      shieldReason: EventShieldReason.UNSIGNED_DEVICE,
    });
    const { svc } = openWithShield(getInfo);

    await vi.waitFor(() =>
      expect(svc.messages()[0].shield).toEqual({
        level: 'grey',
        reason: expect.any(String),
        explanation: expect.any(String),
      }),
    );
  });

  it('projects a red shield for a red colour', async () => {
    const getInfo = vi.fn().mockResolvedValue({
      shieldColour: EventShieldColour.RED,
      shieldReason: EventShieldReason.UNVERIFIED_IDENTITY,
    });
    const { svc } = openWithShield(getInfo);

    await vi.waitFor(() => expect(svc.messages()[0].shield?.level).toBe('red'));
  });

  it('leaves an unencrypted message without a shield (no crypto probe)', async () => {
    const getInfo = vi.fn();
    const { svc } = openWithShield(getInfo, false);

    await Promise.resolve();
    expect(svc.messages()[0].shield ?? null).toBeNull();
    expect(getInfo).not.toHaveBeenCalled();
  });

  describe('in a room with encryption enabled', () => {
    const encryptionEvent = () =>
      fakeEvent({
        id: '$enc',
        sender: '@a:hs',
        type: 'm.room.encryption',
        stateKey: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      });

    it('marks a plaintext message as not encrypted, with no crypto probe', () => {
      const getInfo = vi.fn();
      const { svc } = openWithEvents(
        getInfo,
        [
          encryptionEvent(),
          fakeEvent({ id: '$plain', sender: '@a:hs', body: 'hi' }),
        ],
        true,
      );

      expect(svc.messages().find((m) => m.id === '$plain')?.shield).toEqual({
        level: 'unencrypted',
        reason: 'Not encrypted',
        explanation: 'This message was sent without end-to-end encryption.',
      });
      expect(getInfo).not.toHaveBeenCalled();
    });

    it('leaves an encrypted message on its crypto-derived shield', async () => {
      const getInfo = vi.fn().mockResolvedValue({
        shieldColour: EventShieldColour.GREY,
        shieldReason: EventShieldReason.UNSIGNED_DEVICE,
      });
      const { svc } = openWithEvents(
        getInfo,
        [
          encryptionEvent(),
          fakeEvent({
            id: '$sealed',
            sender: '@a:hs',
            body: 'hi',
            encrypted: true,
          }),
        ],
        true,
      );

      await vi.waitFor(() =>
        expect(
          svc.messages().find((m) => m.id === '$sealed')?.shield,
        ).toMatchObject({ level: 'grey' }),
      );
    });

    it('does not mark a local echo or a state line', () => {
      const { svc } = openWithEvents(
        vi.fn(),
        [
          encryptionEvent(),
          fakeEvent({
            id: '$echo',
            sender: '@me:hs',
            body: 'sending',
            status: 'sending',
          }),
          fakeEvent({
            id: '$topic',
            sender: '@a:hs',
            type: 'm.room.topic',
            stateKey: '',
            content: { topic: 'new topic' },
          }),
        ],
        true,
      );

      const echo = svc.messages().find((m) => m.id === '$echo');
      expect(echo).toBeDefined();
      expect(echo?.shield ?? null).toBeNull();
      expect(
        svc.messages().find((m) => m.id === '$topic')?.shield ?? null,
      ).toBeNull();
    });

    // Every plaintext message is marked. The room's encryption event dates the change: a
    // message dated before it gets the quieter grey mark, one at or after it the red mark.
    it('marks a message dated before encryption grey and one dated after it red', () => {
      const { svc } = openWithEvents(
        vi.fn(),
        [
          fakeEvent({ id: '$old', sender: '@a:hs', body: 'before', ts: 500 }),
          encryptionEvent(),
          fakeEvent({ id: '$new', sender: '@a:hs', body: 'after', ts: 1500 }),
        ],
        true,
        false,
        1000,
      );

      const shieldOf = (id: string) =>
        svc.messages().find((m) => m.id === id)?.shield;
      expect(shieldOf('$old')).toEqual({
        level: 'unencrypted-history',
        reason: 'Not encrypted',
        explanation:
          'This message is dated before the room turned on end-to-end encryption.',
      });
      expect(shieldOf('$new')).toMatchObject({ level: 'unencrypted' });
    });

    it('does not show a state event of a message type as a message row', () => {
      const { svc } = openWithEvents(
        vi.fn(),
        [
          encryptionEvent(),
          fakeEvent({
            id: '$state-message',
            sender: '@a:hs',
            body: 'keyed message',
            stateKey: 'x',
          }),
          fakeEvent({ id: '$after', sender: '@a:hs', body: 'after' }),
        ],
        true,
      );

      expect(svc.messages().map((m) => m.id)).not.toContain('$state-message');
      expect(svc.messages().map((m) => m.id)).toContain('$after');
    });

    it('probes the crypto API with the edit, which supplies the text, not the original', async () => {
      const getInfo = vi.fn().mockResolvedValue({
        shieldColour: EventShieldColour.GREY,
        shieldReason: EventShieldReason.UNSIGNED_DEVICE,
      });
      const edit = fakeEdit('$sealed', true);
      const { svc } = openWithEvents(
        getInfo,
        [
          encryptionEvent(),
          fakeEvent({
            id: '$sealed',
            sender: '@a:hs',
            body: 'edited text',
            encrypted: true,
            replacement: edit,
          }),
        ],
        true,
      );

      await vi.waitFor(() =>
        expect(
          svc.messages().find((m) => m.id === '$sealed')?.shield,
        ).toMatchObject({ level: 'grey' }),
      );
      expect(getInfo.mock.calls.map(([event]) => event.getId())).toEqual([
        '$sealed~edit',
      ]);
    });

    // matrix-js-sdk encrypts a send when the room state says so or its crypto store has
    // the room recorded as encrypted. A room whose state lacks the encryption event but
    // whose store has it is still one the client encrypts for.
    it('marks a plaintext message when only the crypto store knows the room is encrypted', async () => {
      const { svc } = openWithEvents(
        vi.fn(),
        [fakeEvent({ id: '$plain', sender: '@a:hs', body: 'hi' })],
        false,
        true,
      );

      await vi.waitFor(() =>
        expect(
          svc.messages().find((m) => m.id === '$plain')?.shield?.level,
        ).toBe('unencrypted'),
      );
    });

    it('marks nothing when neither the state nor the store says the room is encrypted', async () => {
      const { svc } = openWithEvents(
        vi.fn(),
        [fakeEvent({ id: '$plain', sender: '@a:hs', body: 'hi' })],
        false,
        false,
      );

      await Promise.resolve();
      await Promise.resolve();
      expect(svc.messages()[0].shield ?? null).toBeNull();
    });
  });

  it('shows no shield when the colour resolves to NONE', async () => {
    const getInfo = vi
      .fn()
      .mockResolvedValue({ shieldColour: EventShieldColour.NONE });
    const { svc } = openWithShield(getInfo);

    await vi.waitFor(() => expect(getInfo).toHaveBeenCalled());
    expect(svc.messages()[0].shield ?? null).toBeNull();
  });

  it('does not re-probe a resolved event on a benign refresh, but does on a trust change', async () => {
    const getInfo = vi.fn().mockResolvedValue({
      shieldColour: EventShieldColour.GREY,
      shieldReason: EventShieldReason.UNSIGNED_DEVICE,
    });
    const { svc, handlers } = openWithShield(getInfo);

    await vi.waitFor(() =>
      expect(svc.messages()[0].shield?.level).toBe('grey'),
    );
    const afterOpen = getInfo.mock.calls.length;

    // A receipt triggers a refresh, but the event is already resolved (and not a
    // decryption failure) — no extra crypto probe.
    handlers.get('room:Room.receipt')?.();
    await Promise.resolve();
    expect(getInfo.mock.calls.length).toBe(afterOpen);

    // A trust change forces a full re-resolve.
    handlers.get('client:userTrustStatusChanged')?.();
    await vi.waitFor(() =>
      expect(getInfo.mock.calls.length).toBeGreaterThan(afterOpen),
    );
  });
});
