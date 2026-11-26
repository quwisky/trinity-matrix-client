import {
  AutoDiscovery,
  ClientEvent,
  Direction,
  EventTimeline,
  EventType,
  MatrixError,
  MatrixEventEvent,
  Method,
  RoomEvent,
  RoomStateEvent,
  type IRoomTimelineData,
  type MatrixClient,
  type MatrixEvent,
  type ReceivedToDeviceMessage,
  type Room,
} from 'matrix-js-sdk';
import { Observable } from 'rxjs';
import type {
  CallToDevice,
  CallTransport,
  RawCallEvent,
} from './call-transport';

type ToDeviceMessage = Parameters<
  MatrixClient['queueToDevice']
>[0]['batch'][number];

const RTC_TRANSPORTS_PREFIX = '/_matrix/client/unstable/org.matrix.msc4143';
const LIVEKIT_PREFIX = '/_matrix/client/unstable/io.element.msc4195';
// Both start together, so the lookup answers within 6 s.
const RTC_TRANSPORTS_TIMEOUT_MS = 5_000;
const WELL_KNOWN_TIMEOUT_MS = 6_000;

// SDK send methods are typed against its known event map; call events are arbitrary types.
type AnyType = never;
type AnyContent = never;

function isReadable(event: MatrixEvent): boolean {
  return (
    !event.isDecryptionFailure() &&
    event.getType() !== EventType.RoomMessageEncrypted
  );
}

// The SDK rejects parent_delay_id (deprecated in MSC4140), so only a plain delay is sent.
function delayMs(delay: { delayMs?: number; parentDelayId?: string }): number {
  if (delay.delayMs === undefined || delay.parentDelayId !== undefined) {
    throw new Error('Only delayed events with a plain delay are supported');
  }
  return delay.delayMs;
}

/** The only code in the calls lib that touches `MatrixClient`; scoped to `roomId`. */
export function matrixCallTransport(
  client: MatrixClient,
  roomId: string,
): CallTransport {
  const toRaw = (event: MatrixEvent): RawCallEvent =>
    ({ ...event.getEffectiveEvent(), room_id: roomId }) as RawCallEvent;
  const readable = (events: Iterable<MatrixEvent>): RawCallEvent[] =>
    [...events].filter(isReadable).map(toRaw);
  const room = (): Room | null => client.getRoom(roomId);
  const unstable = <T>(
    prefix: string,
    method: Method,
    path: string,
    body?: unknown,
  ) =>
    client.http.authedRequest<T>(method, path, undefined, body as never, {
      prefix,
    });

  return {
    roomId,
    userId: client.getSafeUserId(),
    deviceId: client.getDeviceId() ?? '',
    homeserverUrl: client.getHomeserverUrl(),

    async sendEvent(type, content, stateKey) {
      const response =
        stateKey === undefined
          ? await client.sendEvent(
              roomId,
              type as AnyType,
              content as AnyContent,
            )
          : await client.sendStateEvent(
              roomId,
              type as AnyType,
              content as AnyContent,
              stateKey,
            );
      return { eventId: response.event_id };
    },

    async sendDelayedEvent(delay, type, content, stateKey) {
      const response =
        stateKey === undefined
          ? await client._unstable_sendDelayedEvent(
              roomId,
              delayMs(delay),
              null,
              type as AnyType,
              content as AnyContent,
            )
          : await client._unstable_sendDelayedStateEvent(
              roomId,
              delayMs(delay),
              type as AnyType,
              content as AnyContent,
              stateKey,
            );
      return { delayId: response.delay_id };
    },

    async updateDelayedEvent(delayId, action) {
      switch (action) {
        case 'cancel':
          await client._unstable_cancelScheduledDelayedEvent(delayId);
          return;
        case 'restart':
          await client._unstable_restartScheduledDelayedEvent(delayId);
          return;
        case 'send':
          await client._unstable_sendScheduledDelayedEvent(delayId);
          return;
      }
    },

    async sendStickyEvent(durationMs, type, content) {
      const response = await client._unstable_sendStickyEvent(
        roomId,
        durationMs,
        null,
        type as AnyType,
        content as AnyContent,
      );
      return { eventId: response.event_id };
    },

    async sendDelayedStickyEvent(delay, durationMs, type, content) {
      const response = await client._unstable_sendStickyDelayedEvent(
        roomId,
        durationMs,
        delayMs(delay),
        null,
        type as AnyType,
        content as AnyContent,
      );
      return { delayId: response.delay_id };
    },

    async sendToDevice(type, encrypted, messages) {
      const batch: ToDeviceMessage[] = Object.entries(messages).flatMap(
        ([userId, devices]) =>
          Object.entries(devices).map(([deviceId, payload]) => ({
            userId,
            deviceId,
            payload: payload as ToDeviceMessage['payload'],
          })),
      );
      if (!encrypted) {
        await client.queueToDevice({ eventType: type, batch });
        return;
      }
      const crypto = client.getCrypto();
      if (!crypto) throw new Error('Encryption is not available');
      // encryptToDeviceMessages takes one payload for many devices.
      const groups = new Map<string, ToDeviceMessage[]>();
      for (const message of batch) {
        const key = JSON.stringify(message.payload);
        groups.set(key, [...(groups.get(key) ?? []), message]);
      }
      for (const group of groups.values()) {
        await client.queueToDevice(
          await crypto.encryptToDeviceMessages(
            type,
            group.map(({ userId, deviceId }) => ({ userId, deviceId })),
            group[0].payload,
          ),
        );
      }
    },

    readState(type, stateKey) {
      const state = room()?.getLiveTimeline().getState(EventTimeline.FORWARDS);
      if (!state) return [];
      if (stateKey === undefined) return readable(state.getStateEvents(type));
      const event = state.getStateEvents(type, stateKey);
      return event ? readable([event]) : [];
    },

    readTimeline(type, limit) {
      const events = readable(room()?.getLiveTimeline().getEvents() ?? [])
        .filter((event) => event.type === type)
        .reverse();
      return limit > 0 ? events.slice(0, limit) : events;
    },

    readStickyEvents() {
      return readable(room()?._unstable_getStickyEvents() ?? []);
    },

    async readRelations(
      eventId,
      { relType, eventType, from, limit, direction },
    ) {
      const result = await client.relations(
        roomId,
        eventId,
        relType ?? null,
        eventType ?? null,
        {
          from,
          limit,
          dir: direction === 'f' ? Direction.Forward : Direction.Backward,
        },
      );
      return {
        chunk: readable(result.events),
        nextBatch: result.nextBatch ?? undefined,
        prevBatch: result.prevBatch ?? undefined,
      };
    },

    openIdToken() {
      return client.getOpenIdToken();
    },

    // Bounded so Element Call gets an answer before the widget API's 10 s request timeout.
    async advertisedRtcTransports() {
      try {
        const response = await withTimeout(
          unstable<{ rtc_transports?: unknown[] }>(
            RTC_TRANSPORTS_PREFIX,
            Method.Get,
            '/rtc/transports',
          ),
          RTC_TRANSPORTS_TIMEOUT_MS,
        );
        // A timeout or a body without the field says nothing about support.
        return Array.isArray(response?.rtc_transports)
          ? response.rtc_transports
          : undefined;
      } catch (error) {
        if (error instanceof MatrixError && isUnsupported(error)) {
          return undefined;
        }
        throw error;
      }
    },

    async rtcTransports() {
      // The client never polls its own well-known copy, so the server name's is read afresh,
      // alongside the endpoint; discovery retries a failing one for up to ~20 s.
      const domain = client.getDomain();
      const wellKnown = domain
        ? withTimeout(
            AutoDiscovery.getRawClientConfig(domain),
            WELL_KNOWN_TIMEOUT_MS,
          ).catch(() => undefined)
        : Promise.resolve(undefined);
      const advertised = await this.advertisedRtcTransports();
      if (advertised?.length) return advertised;
      const foci = (await wellKnown)?.['org.matrix.msc4143.rtc_foci'];
      return Array.isArray(foci) ? foci : [];
    },

    livekitToken(body) {
      return unstable<{ jwt: string }>(
        LIVEKIT_PREFIX,
        Method.Post,
        '/rtc/livekit/get_token',
        body,
      );
    },

    async delegateLivekitDelayedLeave(body) {
      await unstable(
        LIVEKIT_PREFIX,
        Method.Post,
        '/rtc/livekit/delegate_delayed_leave',
        body,
      );
    },

    roomEvents() {
      return new Observable<RawCallEvent>((subscriber) => {
        const emit = (event: MatrixEvent) => {
          if (!subscriber.closed && isReadable(event)) {
            subscriber.next(toRaw(event));
          }
        };
        // Live events still awaiting a readable decryption; each leaves once emitted.
        const pending = new WeakSet<MatrixEvent>();
        const emitPending = (event: MatrixEvent) => {
          if (pending.has(event) && isReadable(event)) {
            pending.delete(event);
            emit(event);
          }
        };
        const onTimeline = (
          event: MatrixEvent,
          eventRoom: Room | undefined,
          toStartOfTimeline: boolean | undefined,
          _removed: boolean,
          data?: IRoomTimelineData,
        ) => {
          // State events are emitted once, by onState.
          if (
            eventRoom?.roomId !== roomId ||
            toStartOfTimeline ||
            data?.liveEvent === false ||
            event.isState()
          ) {
            return;
          }
          if (isReadable(event)) {
            emit(event);
            return;
          }
          pending.add(event);
          // Keys that arrive later re-decrypt the event and fire onDecrypted.
          client.decryptEventIfNeeded(event).then(
            () => emitPending(event),
            () => undefined,
          );
        };
        const onState = (event: MatrixEvent) => {
          if (event.getRoomId() === roomId) emit(event);
        };
        client.on(RoomEvent.Timeline, onTimeline);
        client.on(RoomStateEvent.Events, onState);
        client.on(MatrixEventEvent.Decrypted, emitPending);
        return () => {
          client.off(RoomEvent.Timeline, onTimeline);
          client.off(RoomStateEvent.Events, onState);
          client.off(MatrixEventEvent.Decrypted, emitPending);
        };
      });
    },

    toDevice() {
      return new Observable<CallToDevice>((subscriber) => {
        const onMessage = ({
          message,
          encryptionInfo,
        }: ReceivedToDeviceMessage) =>
          subscriber.next({
            type: message.type,
            sender: message.sender,
            content: message.content,
            encrypted: encryptionInfo !== null,
          });
        client.on(ClientEvent.ReceivedToDeviceMessage, onMessage);
        return () => client.off(ClientEvent.ReceivedToDeviceMessage, onMessage);
      });
    },
  };
}

/** `promise`'s value, or undefined once `ms` pass without one. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** How a homeserver without an endpoint answers: 404, 405, or 400 `M_UNRECOGNIZED`. */
function isUnsupported(error: MatrixError): boolean {
  return (
    error.httpStatus === 404 ||
    error.httpStatus === 405 ||
    (error.httpStatus === 400 && error.errcode === 'M_UNRECOGNIZED')
  );
}
