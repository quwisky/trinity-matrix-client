import { EventEmitter } from 'node:events';
import {
  ClientEvent,
  Direction,
  MatrixError,
  MatrixEvent,
  MatrixEventEvent,
  Method,
  RoomEvent,
  RoomStateEvent,
  type IEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { RawCallEvent } from './call-transport';
import { matrixCallTransport } from './matrix-call-transport';

const ROOM = '!r:hs';

function matrixEvent(fields: Partial<IEvent>): MatrixEvent {
  return new MatrixEvent({
    type: 'm.rtc.notification',
    event_id: '$e',
    room_id: ROOM,
    sender: '@a:hs',
    origin_server_ts: 1,
    content: {},
    ...fields,
  });
}

function setup() {
  const crypto = {
    encryptToDeviceMessages: vi.fn(
      (eventType: string, devices: unknown[], payload: unknown) =>
        Promise.resolve({
          eventType: 'm.room.encrypted',
          batch: [devices, payload],
        }),
    ),
  };
  const timeline = [
    matrixEvent({ event_id: '$1', type: 'm.reaction' }),
    matrixEvent({ event_id: '$2', type: 'm.rtc.notification' }),
    matrixEvent({ event_id: '$3', type: 'm.reaction' }),
    matrixEvent({ event_id: '$x', type: 'm.room.encrypted' }),
  ];
  const member = matrixEvent({
    event_id: '$m',
    type: 'org.matrix.msc3401.call.member',
    state_key: '@a:hs',
  });
  const room = {
    roomId: ROOM,
    getLiveTimeline: () => ({
      getEvents: () => timeline,
      getState: () => ({
        getStateEvents: (_type: string, stateKey?: string) =>
          stateKey === undefined
            ? [member]
            : stateKey === '@a:hs'
              ? member
              : null,
      }),
    }),
    _unstable_getStickyEvents: () =>
      new Set([member, matrixEvent({ type: 'm.room.encrypted' })]),
  };
  const emitter = new EventEmitter();
  const stub = {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    getSafeUserId: () => '@a:hs',
    getDeviceId: () => 'DEV',
    getHomeserverUrl: () => 'https://hs',
    getRoom: vi.fn((id: string) => (id === ROOM ? room : null)),
    getCrypto: () => crypto,
    decryptEventIfNeeded: vi.fn(() => Promise.resolve()),
    sendEvent: vi.fn().mockResolvedValue({ event_id: '$sent' }),
    sendStateEvent: vi.fn().mockResolvedValue({ event_id: '$state' }),
    _unstable_sendDelayedEvent: vi.fn().mockResolvedValue({ delay_id: 'd' }),
    _unstable_sendDelayedStateEvent: vi
      .fn()
      .mockResolvedValue({ delay_id: 'ds' }),
    _unstable_sendStickyEvent: vi.fn().mockResolvedValue({ event_id: '$st' }),
    _unstable_sendStickyDelayedEvent: vi
      .fn()
      .mockResolvedValue({ delay_id: 'dst' }),
    _unstable_cancelScheduledDelayedEvent: vi.fn().mockResolvedValue({}),
    _unstable_restartScheduledDelayedEvent: vi.fn().mockResolvedValue({}),
    _unstable_sendScheduledDelayedEvent: vi.fn().mockResolvedValue({}),
    queueToDevice: vi.fn().mockResolvedValue(undefined),
    relations: vi.fn().mockResolvedValue({
      events: [member],
      nextBatch: 'n',
      prevBatch: null,
    }),
    getOpenIdToken: vi.fn().mockResolvedValue({ access_token: 't' }),
    getClientWellKnown: vi.fn(() => ({
      'org.matrix.msc4143.rtc_foci': [{ type: 'livekit' }],
    })),
    http: { authedRequest: vi.fn() },
  };
  const client = stub as unknown as MatrixClient;
  return {
    stub,
    crypto,
    emitter,
    member,
    transport: matrixCallTransport(client, ROOM),
  };
}

function collect<T>(source: {
  subscribe(next: (value: T) => void): { unsubscribe(): void };
}) {
  const values: T[] = [];
  const subscription = source.subscribe((value) => values.push(value));
  return { values, subscription };
}

describe('matrixCallTransport', () => {
  it('exposes the session identity', () => {
    const { transport } = setup();
    expect(transport).toMatchObject({
      roomId: ROOM,
      userId: '@a:hs',
      deviceId: 'DEV',
      homeserverUrl: 'https://hs',
    });
  });

  it('sends timeline and state events to its room', async () => {
    const { stub, transport } = setup();
    await expect(transport.sendEvent('t', { a: 1 })).resolves.toEqual({
      eventId: '$sent',
    });
    expect(stub.sendEvent).toHaveBeenCalledWith(ROOM, 't', { a: 1 });
    await expect(transport.sendEvent('s', { b: 1 }, 'k')).resolves.toEqual({
      eventId: '$state',
    });
    expect(stub.sendStateEvent).toHaveBeenCalledWith(ROOM, 's', { b: 1 }, 'k');
  });

  it('sends delayed events with the request shape the SDK expects', async () => {
    const { stub, transport } = setup();
    await expect(
      transport.sendDelayedEvent({ delayMs: 5000 }, 't', { a: 1 }),
    ).resolves.toEqual({ delayId: 'd' });
    expect(stub._unstable_sendDelayedEvent).toHaveBeenCalledWith(
      ROOM,
      5000,
      null,
      't',
      { a: 1 },
    );
    await expect(
      transport.sendDelayedEvent({ delayMs: 5000 }, 's', { b: 1 }, 'k'),
    ).resolves.toEqual({ delayId: 'ds' });
    expect(stub._unstable_sendDelayedStateEvent).toHaveBeenCalledWith(
      ROOM,
      5000,
      's',
      { b: 1 },
      'k',
    );
    await expect(
      transport.sendDelayedEvent({ parentDelayId: 'p' }, 't', {}),
    ).rejects.toThrow('plain delay');
  });

  it('routes each delayed-event action to its SDK method', async () => {
    const { stub, transport } = setup();
    await transport.updateDelayedEvent('d', 'cancel');
    await transport.updateDelayedEvent('d', 'restart');
    await transport.updateDelayedEvent('d', 'send');
    expect(stub._unstable_cancelScheduledDelayedEvent).toHaveBeenCalledWith(
      'd',
    );
    expect(stub._unstable_restartScheduledDelayedEvent).toHaveBeenCalledWith(
      'd',
    );
    expect(stub._unstable_sendScheduledDelayedEvent).toHaveBeenCalledWith('d');
  });

  it('sends sticky and delayed sticky events', async () => {
    const { stub, transport } = setup();
    await expect(
      transport.sendStickyEvent(3600000, 't', { a: 1 }),
    ).resolves.toEqual({ eventId: '$st' });
    expect(stub._unstable_sendStickyEvent).toHaveBeenCalledWith(
      ROOM,
      3600000,
      null,
      't',
      { a: 1 },
    );
    await expect(
      transport.sendDelayedStickyEvent({ delayMs: 5000 }, 3600000, 't', {}),
    ).resolves.toEqual({ delayId: 'dst' });
    expect(stub._unstable_sendStickyDelayedEvent).toHaveBeenCalledWith(
      ROOM,
      3600000,
      5000,
      null,
      't',
      {},
    );
  });

  it('encrypts to-device messages once per distinct payload', async () => {
    const { stub, crypto, transport } = setup();
    await transport.sendToDevice('io.element.call.encryption_keys', true, {
      '@a:hs': { A1: { k: 1 }, A2: { k: 2 } },
      '@b:hs': { B1: { k: 1 } },
    });
    expect(crypto.encryptToDeviceMessages).toHaveBeenCalledTimes(2);
    expect(crypto.encryptToDeviceMessages).toHaveBeenCalledWith(
      'io.element.call.encryption_keys',
      [
        { userId: '@a:hs', deviceId: 'A1' },
        { userId: '@b:hs', deviceId: 'B1' },
      ],
      { k: 1 },
    );
    expect(crypto.encryptToDeviceMessages).toHaveBeenCalledWith(
      'io.element.call.encryption_keys',
      [{ userId: '@a:hs', deviceId: 'A2' }],
      { k: 2 },
    );
    expect(stub.queueToDevice).toHaveBeenCalledTimes(2);
    expect(stub.queueToDevice).toHaveBeenCalledWith({
      eventType: 'm.room.encrypted',
      batch: [[{ userId: '@a:hs', deviceId: 'A2' }], { k: 2 }],
    });
  });

  it('queues clear to-device messages without encrypting them', async () => {
    const { stub, crypto, transport } = setup();
    await transport.sendToDevice('t', false, { '@b:hs': { B1: { k: 1 } } });
    expect(crypto.encryptToDeviceMessages).not.toHaveBeenCalled();
    expect(stub.queueToDevice).toHaveBeenCalledWith({
      eventType: 't',
      batch: [{ userId: '@b:hs', deviceId: 'B1', payload: { k: 1 } }],
    });
  });

  it('reads matching state of its room', () => {
    const { transport } = setup();
    expect(transport.readState('org.matrix.msc3401.call.member')).toEqual([
      expect.objectContaining({ event_id: '$m', state_key: '@a:hs' }),
    ]);
    expect(
      transport.readState('org.matrix.msc3401.call.member', '@a:hs'),
    ).toHaveLength(1);
    expect(
      transport.readState('org.matrix.msc3401.call.member', '@z:hs'),
    ).toEqual([]);
  });

  it('reads the timeline newest first, with 0 meaning no limit', () => {
    const { transport } = setup();
    const ids = (events: RawCallEvent[]) => events.map((e) => e.event_id);
    expect(ids(transport.readTimeline('m.reaction', 0))).toEqual(['$3', '$1']);
    expect(ids(transport.readTimeline('m.reaction', 1))).toEqual(['$3']);
    expect(transport.readTimeline('m.room.encrypted', 0)).toEqual([]);
  });

  it('reads decrypted sticky events only', () => {
    const { transport } = setup();
    expect(transport.readStickyEvents().map((e) => e.event_id)).toEqual(['$m']);
  });

  it('reads relations of an event in its room', async () => {
    const { stub, transport } = setup();
    await expect(
      transport.readRelations('$p', {
        relType: 'm.reference',
        limit: 5,
        direction: 'b',
      }),
    ).resolves.toEqual({
      chunk: [expect.objectContaining({ event_id: '$m' })],
      nextBatch: 'n',
      prevBatch: undefined,
    });
    expect(stub.relations).toHaveBeenCalledWith(
      ROOM,
      '$p',
      'm.reference',
      null,
      {
        from: undefined,
        limit: 5,
        dir: Direction.Backward,
      },
    );
  });

  it('requests an OpenID token', async () => {
    const { transport } = setup();
    await expect(transport.openIdToken()).resolves.toEqual({
      access_token: 't',
    });
  });

  it('reads RTC transports, falling back to well-known on 404', async () => {
    const { stub, transport } = setup();
    stub.http.authedRequest.mockResolvedValueOnce({
      rtc_transports: [{ type: 'a' }],
    });
    await expect(transport.rtcTransports()).resolves.toEqual([{ type: 'a' }]);
    expect(stub.http.authedRequest).toHaveBeenCalledWith(
      Method.Get,
      '/rtc/transports',
      undefined,
      undefined,
      { prefix: '/_matrix/client/unstable/org.matrix.msc4143' },
    );
    stub.http.authedRequest.mockRejectedValueOnce(
      new MatrixError({ errcode: 'M_UNRECOGNIZED' }, 404),
    );
    await expect(transport.rtcTransports()).resolves.toEqual([
      { type: 'livekit' },
    ]);
    const failure = new MatrixError({ errcode: 'M_UNKNOWN' }, 500);
    stub.http.authedRequest.mockRejectedValueOnce(failure);
    await expect(transport.rtcTransports()).rejects.toBe(failure);
  });

  it.each([
    ['400 M_UNRECOGNIZED', new MatrixError({ errcode: 'M_UNRECOGNIZED' }, 400)],
    ['405', new MatrixError({ errcode: 'M_UNRECOGNIZED' }, 405)],
    ['405 without an errcode', new MatrixError({}, 405)],
  ])('falls back to well-known RTC transports on %s', async (_label, error) => {
    const { stub, transport } = setup();
    stub.http.authedRequest.mockRejectedValueOnce(error);
    await expect(transport.rtcTransports()).resolves.toEqual([
      { type: 'livekit' },
    ]);
  });

  it('rejects a 400 other than M_UNRECOGNIZED', async () => {
    const { stub, transport } = setup();
    const failure = new MatrixError({ errcode: 'M_BAD_JSON' }, 400);
    stub.http.authedRequest.mockRejectedValueOnce(failure);
    await expect(transport.rtcTransports()).rejects.toBe(failure);
  });

  it('posts LiveKit requests verbatim', async () => {
    const { stub, transport } = setup();
    const prefix = { prefix: '/_matrix/client/unstable/io.element.msc4195' };
    stub.http.authedRequest.mockResolvedValueOnce({ jwt: 'j' });
    await expect(transport.livekitToken({ a: 1 })).resolves.toEqual({
      jwt: 'j',
    });
    expect(stub.http.authedRequest).toHaveBeenCalledWith(
      Method.Post,
      '/rtc/livekit/get_token',
      undefined,
      { a: 1 },
      prefix,
    );
    stub.http.authedRequest.mockResolvedValueOnce({});
    await transport.delegateLivekitDelayedLeave({ b: 2 });
    expect(stub.http.authedRequest).toHaveBeenLastCalledWith(
      Method.Post,
      '/rtc/livekit/delegate_delayed_leave',
      undefined,
      { b: 2 },
      prefix,
    );
  });

  it('emits decrypted live events of its room until unsubscribed', async () => {
    const { emitter, member, transport } = setup();
    const { values, subscription } = collect(transport.roomEvents());
    const room = { roomId: ROOM };
    emitter.emit(
      RoomEvent.Timeline,
      matrixEvent({ event_id: '$t' }),
      room,
      false,
    );
    emitter.emit(
      RoomEvent.Timeline,
      matrixEvent({ event_id: '$old' }),
      room,
      true,
    );
    emitter.emit(
      RoomEvent.Timeline,
      matrixEvent({ event_id: '$o', room_id: '!other:hs' }),
      { roomId: '!other:hs' },
      false,
    );
    emitter.emit(
      RoomEvent.Timeline,
      matrixEvent({ event_id: '$enc', type: 'm.room.encrypted' }),
      room,
      false,
    );
    // State arrives through RoomStateEvent.Events; the timeline copy would duplicate it.
    emitter.emit(RoomEvent.Timeline, member, room, false);
    emitter.emit(RoomStateEvent.Events, member);
    emitter.emit(
      RoomStateEvent.Events,
      matrixEvent({ event_id: '$os', room_id: '!other:hs', state_key: '' }),
    );
    await vi.waitFor(() => expect(values).toHaveLength(2));
    expect(values.map((e) => e.event_id).sort()).toEqual(['$m', '$t']);
    expect(values.find((e) => e.event_id === '$t')).toMatchObject({
      type: 'm.rtc.notification',
      room_id: ROOM,
      sender: '@a:hs',
    });

    subscription.unsubscribe();
    expect(emitter.listenerCount(RoomEvent.Timeline)).toBe(0);
    expect(emitter.listenerCount(RoomStateEvent.Events)).toBe(0);
  });

  it('emits a live event once it decrypts late, only once', async () => {
    const { emitter, stub, transport } = setup();
    const { values, subscription } = collect(transport.roomEvents());
    const room = { roomId: ROOM };
    const late = matrixEvent({ event_id: '$late', type: 'm.room.encrypted' });
    const failure = vi.spyOn(late, 'isDecryptionFailure').mockReturnValue(true);
    emitter.emit(RoomEvent.Timeline, late, room, false, false, {
      liveEvent: true,
    });
    emitter.emit(MatrixEventEvent.Decrypted, late, new Error('no key'));
    await vi.waitFor(() =>
      expect(stub.decryptEventIfNeeded).toHaveBeenCalledWith(late),
    );
    expect(values).toEqual([]);

    failure.mockReturnValue(false);
    vi.spyOn(late, 'getType').mockReturnValue(
      'io.element.call.encryption_keys',
    );
    vi.spyOn(late, 'getEffectiveEvent').mockReturnValue({
      ...late.event,
      type: 'io.element.call.encryption_keys',
    } as IEvent);
    emitter.emit(MatrixEventEvent.Decrypted, late);
    emitter.emit(MatrixEventEvent.Decrypted, late);
    // Not seen live: a paginated or unrelated event stays out.
    emitter.emit(MatrixEventEvent.Decrypted, matrixEvent({ event_id: '$u' }));
    emitter.emit(
      RoomEvent.Timeline,
      matrixEvent({ event_id: '$notLive' }),
      room,
      false,
      false,
      { liveEvent: false },
    );
    expect(values).toEqual([
      expect.objectContaining({
        event_id: '$late',
        type: 'io.element.call.encryption_keys',
      }),
    ]);

    subscription.unsubscribe();
    expect(emitter.listenerCount(MatrixEventEvent.Decrypted)).toBe(0);
  });

  it('emits received to-device messages until unsubscribed', () => {
    const { emitter, transport } = setup();
    const { values, subscription } = collect(transport.toDevice());
    const message = { type: 't', sender: '@b:hs', content: { k: 1 } };
    emitter.emit(ClientEvent.ReceivedToDeviceMessage, {
      message,
      encryptionInfo: {},
    });
    emitter.emit(ClientEvent.ReceivedToDeviceMessage, {
      message,
      encryptionInfo: null,
    });
    expect(values).toEqual([
      { ...message, encrypted: true },
      { ...message, encrypted: false },
    ]);

    subscription.unsubscribe();
    expect(emitter.listenerCount(ClientEvent.ReceivedToDeviceMessage)).toBe(0);
  });
});
