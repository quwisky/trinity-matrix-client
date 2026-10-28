import { Injectable, inject } from '@angular/core';
import {
  EventType,
  type MatrixClient,
  type MatrixEvent,
  RoomEvent,
  RoomStateEvent,
} from 'matrix-js-sdk';
import { NEVER, Observable, catchError, concat, defer, from, of } from 'rxjs';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import {
  type EngineFailure,
  type EngineResult,
  NOT_SIGNED_IN,
  describeMatrixRequestFailure,
  engineFail,
  engineOk,
  liveRoomState,
} from '@trinity/util/matrix';
import type {
  RoomWidgetEngine,
  RoomWidgetSnapshot,
  RoomWidgetStateContent,
  WidgetIdentity,
} from '../room-widget-engine';
import { isCallWidgetType } from '../widget-embed-policy';
import { type RoomWidget, WIDGET_EVENT_TYPE } from '../widget.model';

const EMPTY: RoomWidgetSnapshot = {
  widgets: [],
  canManage: false,
  identity: null,
};

function localFailure(
  code: 'forbidden' | 'conflict' | 'state-key-taken' | 'unsupported',
): EngineFailure {
  return { kind: 'unexpected', code, diagnostic: { kind: 'unexpected' } };
}

function requestFailed(error: unknown): EngineFailure {
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  return {
    kind,
    code: 'request-failed',
    diagnostic,
    ...(diagnostic.errorName === 'TokenRefreshError'
      ? { params: { cause: 'session-refresh' as const } }
      : {}),
  };
}

/** {@link RoomWidgetEngine} over the live matrix-js-sdk clients of {@link JS_SDK_CLIENTS}. */
@Injectable({ providedIn: 'root' })
export class JsSdkRoomWidgetEngine implements RoomWidgetEngine {
  private readonly clients = inject(JS_SDK_CLIENTS);

  roomWidgets(
    accountId: string,
    roomId: string,
  ): Observable<RoomWidgetSnapshot> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return concat(of(EMPTY), NEVER);
      return new Observable<RoomWidgetSnapshot>((subscriber) => {
        let active = true;
        let queued = false;
        const publish = (): void => {
          // A replaced client is not followed; the caller subscribes again for the new one.
          if (!active || this.clients.clientFor(accountId) !== client) {
            return;
          }
          subscriber.next(snapshotFrom(client, accountId, roomId));
        };
        const schedule = (): void => {
          if (queued) return;
          queued = true;
          queueMicrotask(() => {
            queued = false;
            publish();
          });
        };
        const onState = (event: MatrixEvent): void => {
          if (
            event.getRoomId() === roomId &&
            (event.getType() === WIDGET_EVENT_TYPE ||
              event.getType() === EventType.RoomPowerLevels ||
              (event.getType() === EventType.RoomMember &&
                event.getStateKey() === client.getUserId()))
          ) {
            schedule();
          }
        };
        const onMembership = (room?: { roomId?: string }): void => {
          if (room?.roomId === roomId) schedule();
        };
        client.on(RoomStateEvent.Events, onState);
        client.on(RoomEvent.MyMembership, onMembership);
        publish();
        return () => {
          active = false;
          client.off(RoomStateEvent.Events, onState);
          client.off(RoomEvent.MyMembership, onMembership);
        };
      });
    });
  }

  putRoomWidget(
    accountId: string,
    roomId: string,
    content: RoomWidgetStateContent,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, roomId, (client, state) => {
      if (state.getStateEvents(WIDGET_EVENT_TYPE, content.id)) {
        return localFailure('state-key-taken');
      }
      return sendWidgetStateEvent(client, roomId, { ...content }, content.id);
    });
  }

  removeRoomWidget(
    accountId: string,
    roomId: string,
    widgetId: string,
    expectedEventId: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, roomId, (client, state) => {
      const current = state.getStateEvents(
        WIDGET_EVENT_TYPE,
        widgetId,
      ) as MatrixEvent | null;
      const currentType = current ? activeWidgetType(current) : null;
      if (
        !expectedEventId ||
        !current?.getId() ||
        current.getId() !== expectedEventId ||
        !currentType
      ) {
        return localFailure('conflict');
      }
      if (isCallWidgetType(currentType)) {
        return localFailure('unsupported');
      }
      return sendWidgetStateEvent(client, roomId, {}, widgetId);
    });
  }

  /**
   * A cold, power-gated write: `not-signed-in` without a client or room, `forbidden`
   * without the power to manage widgets, a thrown error as `request-failed`.
   */
  private command(
    accountId: string,
    roomId: string,
    run: (
      client: MatrixClient,
      state: NonNullable<ReturnType<typeof liveRoomState>>,
    ) => EngineFailure | Promise<unknown>,
  ): Observable<EngineResult<null>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      const room = client?.getRoom(roomId);
      const state = room ? liveRoomState(room) : undefined;
      if (!client || !state || !client.getUserId()) {
        return of(engineFail(NOT_SIGNED_IN));
      }
      if (!canManageRoomWidgets(client, roomId)) {
        return of(engineFail(localFailure('forbidden')));
      }
      const outcome = run(client, state);
      if (!('then' in outcome)) return of(engineFail(outcome));
      return from(outcome.then(() => engineOk(null))).pipe(
        catchError((error: unknown) => of(engineFail(requestFailed(error)))),
      );
    });
  }
}

function snapshotFrom(
  client: MatrixClient,
  accountId: string,
  roomId: string,
): RoomWidgetSnapshot {
  return {
    widgets: readRoomWidgets(client, roomId),
    canManage: canManageRoomWidgets(client, roomId),
    identity: identityOf(client, accountId, roomId),
  };
}

function identityOf(
  client: MatrixClient,
  accountId: string,
  roomId: string,
): WidgetIdentity {
  const userId = client.getUserId() ?? accountId;
  const roomMember = client.getRoom(roomId)?.getMember(userId);
  const user = client.getUser(userId);
  const avatarMxc = roomMember?.getMxcAvatarUrl() ?? user?.avatarUrl ?? '';
  const avatarUrl = avatarMxc
    ? (client.mxcUrlToHttp(avatarMxc, 96, 96, 'crop', false, false, false) ??
      '')
    : '';
  return {
    userId,
    displayName: roomMember?.rawDisplayName ?? user?.displayName ?? userId,
    avatarUrl,
    deviceId: client.getDeviceId() ?? '',
    homeserverUrl: client.getHomeserverUrl() ?? '',
  };
}

function readRoomWidgets(
  client: MatrixClient,
  roomId: string,
): readonly RoomWidget[] {
  const room = client.getRoom(roomId);
  const state = room ? liveRoomState(room) : undefined;
  if (!state) {
    return [];
  }
  const widgets: RoomWidget[] = [];
  for (const event of state.getStateEvents(WIDGET_EVENT_TYPE)) {
    const widget = widgetFrom(event);
    if (widget) {
      widgets.push(widget);
    }
  }
  return widgets;
}

function widgetFrom(event: MatrixEvent): RoomWidget | null {
  const id = event.getStateKey();
  const content: unknown = event.getContent();
  if (!id || !isRecord(content)) {
    return null;
  }
  const type = text(content['type']);
  const rawUrl =
    typeof content['url'] === 'string' && content['url'].trim()
      ? content['url']
      : '';
  if (!type || !rawUrl) {
    return null;
  }
  const data = isRecord(content['data']) ? content['data'] : {};
  return {
    id,
    name: text(content['name']) ?? text(data['title']) ?? 'Unnamed widget',
    type,
    rawUrl,
    data,
    creatorUserId: text(content['creatorUserId']) ?? text(event.getSender()),
    waitForIframeLoad:
      typeof content['waitForIframeLoad'] === 'boolean'
        ? content['waitForIframeLoad']
        : true,
    sourceEventId: event.getId() ?? null,
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The shared read/write authorization predicate for legacy room widget state. */
function canManageRoomWidgets(client: MatrixClient, roomId: string): boolean {
  const room = client.getRoom(roomId);
  const state = room ? liveRoomState(room) : undefined;
  return !!(
    room?.getMyMembership() === 'join' &&
    !client.isGuest() &&
    state?.mayClientSendStateEvent(WIDGET_EVENT_TYPE, client)
  );
}

function sendWidgetStateEvent(
  client: MatrixClient,
  roomId: string,
  content: Record<string, unknown>,
  stateKey: string,
): Promise<unknown> {
  // The SDK's StateEvents map intentionally cannot enumerate this legacy extension
  // event. Keep the type boundary here while preserving the normal client call.
  const send = client.sendStateEvent.bind(client) as unknown as (
    targetRoomId: string,
    eventType: typeof WIDGET_EVENT_TYPE,
    eventContent: Record<string, unknown>,
    targetStateKey: string,
  ) => Promise<unknown>;
  return send(roomId, WIDGET_EVENT_TYPE, content, stateKey);
}

function activeWidgetType(event: MatrixEvent): string | null {
  const content: unknown = event.getContent();
  if (
    content &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    typeof (content as Record<string, unknown>)['type'] === 'string' &&
    typeof (content as Record<string, unknown>)['url'] === 'string'
  ) {
    return (content as Record<string, unknown>)['type'] as string;
  }
  return null;
}
