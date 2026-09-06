import {
  Injector,
  Injectable,
  type Signal,
  type WritableSignal,
  inject,
  signal,
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  EventType,
  type MatrixClient,
  type MatrixEvent,
  RoomEvent,
  RoomStateEvent,
} from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { liveRoomState } from '@trinity/util/matrix';
import { Observable, Subscription, of } from 'rxjs';
import { WIDGET_APPEARANCE_PROJECTION } from './widget-appearance-projection';
import type {
  RoomWidget,
  RoomWidgetTarget,
  WidgetLaunch,
  WidgetTemplateContext,
} from './widget.model';
import { resolveWidgetLaunch } from './widget-template';

/** The legacy room-state event used by deployed Matrix widgets. */
export const WIDGET_EVENT_TYPE = 'im.vector.modular.widgets';
const TRINITY_WIDGET_CLIENT_ID = 'eu.qwky.trinity';

interface WatchedRoom {
  readonly target: RoomWidgetTarget;
  readonly state: WritableSignal<readonly RoomWidget[]>;
  readonly canManage: WritableSignal<boolean>;
  consumers: number;
  subscription: Subscription | null;
}

interface WidgetSnapshot {
  readonly widgets: readonly RoomWidget[];
  readonly canManage: boolean;
}

/**
 * Demand-driven projection of the widgets declared in rooms whose settings dialog has
 * asked for them. Tier 1 deliberately stops at discovery and an external browser link —
 * no iframe, postMessage bridge, decrypted events, or widget writes live here.
 */
@Injectable({ providedIn: 'root' })
export class WidgetsService {
  private readonly matrix = inject(MatrixClientService);
  private readonly appearance = inject(WIDGET_APPEARANCE_PROJECTION);
  private readonly injector = inject(Injector);
  private readonly watched = new Map<string, WatchedRoom>();

  /**
   * Widgets currently declared in one room. The signal is memoized and synchronously
   * seeded, so the dialog does not flash an empty state before its first render.
   */
  widgetsFor(target: RoomWidgetTarget): Signal<readonly RoomWidget[]> {
    return this.watchedRoom(target).state.asReadonly();
  }

  /** Live management authorization for the exact Account in one watched Room. */
  canManageFor(target: RoomWidgetTarget): Signal<boolean> {
    return this.watchedRoom(target).canManage.asReadonly();
  }

  /** Acquire one exact target and attach its filtered listener for the first consumer. */
  connect(target: RoomWidgetTarget): void {
    const watched = this.watchedRoom(target);
    watched.consumers += 1;
    if (watched.consumers > 1) return;
    const lifetime = new Subscription();
    let connectedClient = this.matrix.clientFor(watched.target.accountId);
    let clientSubscription = this.observeCurrentClient(
      watched.target,
    ).subscribe((snapshot) => {
      watched.state.set(snapshot.widgets);
      watched.canManage.set(snapshot.canManage);
    });
    lifetime.add(
      toObservable(this.matrix.accountIds, {
        injector: this.injector,
      }).subscribe(() => {
        const nextClient = this.matrix.clientFor(watched.target.accountId);
        if (nextClient === connectedClient) return;
        connectedClient = nextClient;
        clientSubscription.unsubscribe();
        clientSubscription = this.observeCurrentClient(
          watched.target,
        ).subscribe((snapshot) => {
          watched.state.set(snapshot.widgets);
          watched.canManage.set(snapshot.canManage);
        });
      }),
    );
    lifetime.add(() => clientSubscription.unsubscribe());
    watched.subscription = lifetime;
  }

  /** Release one consumer without disrupting another settings view of this target. */
  disconnect(target: RoomWidgetTarget): void {
    const key = targetKey(target);
    const watched = this.watched.get(key);
    if (!watched) {
      return;
    }
    watched.consumers = Math.max(0, watched.consumers - 1);
    if (watched.consumers > 0) {
      return;
    }
    watched.subscription?.unsubscribe();
    watched.subscription = null;
    watched.state.set([]);
    watched.canManage.set(false);
    this.watched.delete(key);
  }

  /** Expand a destination using the immutable opening Account and current client UI. */
  launchFor(target: RoomWidgetTarget, widget: RoomWidget): WidgetLaunch {
    return resolveWidgetLaunch(widget, this.templateContext(target));
  }

  private watchedRoom(target: RoomWidgetTarget): WatchedRoom {
    const key = targetKey(target);
    let watched = this.watched.get(key);
    if (!watched) {
      const stableTarget = { ...target };
      const client = this.matrix.clientFor(stableTarget.accountId);
      watched = {
        target: stableTarget,
        state: signal<readonly RoomWidget[]>(
          readRoomWidgets(client, stableTarget.roomId),
          { equal: sameWidgets },
        ),
        canManage: signal(canManageRoomWidgets(client, stableTarget.roomId)),
        consumers: 0,
        subscription: null,
      };
      this.watched.set(key, watched);
    }
    return watched;
  }

  private observeCurrentClient(
    target: RoomWidgetTarget,
  ): Observable<WidgetSnapshot> {
    const client = this.matrix.clientFor(target.accountId);
    if (!client) return of(emptySnapshot());
    return new Observable((subscriber) => {
      let active = true;
      let queued = false;
      const publish = (): void => {
        if (!active || this.matrix.clientFor(target.accountId) !== client) {
          return;
        }
        subscriber.next(snapshotFrom(client, target.roomId));
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
          event.getRoomId() === target.roomId &&
          (event.getType() === WIDGET_EVENT_TYPE ||
            event.getType() === EventType.RoomPowerLevels)
        ) {
          schedule();
        }
      };
      const onMembership = (room?: { roomId?: string }): void => {
        if (room?.roomId === target.roomId) schedule();
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
  }

  private templateContext(target: RoomWidgetTarget): WidgetTemplateContext {
    // Account registry changes invalidate computed launch URLs after exact-client
    // removal/restoration without ever following the active Account.
    this.matrix.accountIds();
    const client = this.matrix.clientFor(target.accountId);
    const userId = client?.getUserId() ?? target.accountId;
    const roomMember = userId
      ? client?.getRoom(target.roomId)?.getMember(userId)
      : null;
    const user = userId ? client?.getUser(userId) : null;
    const avatarMxc = roomMember?.getMxcAvatarUrl() ?? user?.avatarUrl ?? '';
    const avatarUrl =
      client && avatarMxc
        ? (client.mxcUrlToHttp(
            avatarMxc,
            96,
            96,
            'crop',
            false,
            false,
            false,
          ) ?? '')
        : '';
    return {
      roomId: target.roomId,
      userId,
      displayName: roomMember?.rawDisplayName ?? user?.displayName ?? userId,
      avatarUrl,
      clientId: TRINITY_WIDGET_CLIENT_ID,
      theme: this.appearance.resolved()?.mode ?? 'dark',
      language: typeof navigator === 'undefined' ? '' : navigator.language,
      deviceId: client?.getDeviceId() ?? '',
      baseUrl: client?.getHomeserverUrl() ?? '',
    };
  }
}

function targetKey(target: RoomWidgetTarget): string {
  return `${target.accountId.length}:${target.accountId}${target.roomId}`;
}

function emptySnapshot(): WidgetSnapshot {
  return { widgets: [], canManage: false };
}

function snapshotFrom(client: MatrixClient, roomId: string): WidgetSnapshot {
  return {
    widgets: readRoomWidgets(client, roomId),
    canManage: canManageRoomWidgets(client, roomId),
  };
}

function readRoomWidgets(
  client: MatrixClient | null,
  roomId: string,
): readonly RoomWidget[] {
  const room = client?.getRoom(roomId);
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

function sameWidgets(
  left: readonly RoomWidget[],
  right: readonly RoomWidget[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (widget, index) =>
        widget.id === right[index]?.id &&
        widget.name === right[index]?.name &&
        widget.type === right[index]?.type &&
        widget.rawUrl === right[index]?.rawUrl &&
        widget.creatorUserId === right[index]?.creatorUserId &&
        widget.waitForIframeLoad === right[index]?.waitForIframeLoad &&
        widget.sourceEventId === right[index]?.sourceEventId &&
        JSON.stringify(widget.data) === JSON.stringify(right[index]?.data),
    )
  );
}

/** The shared read/write authorization predicate for legacy room widget state. */
export function canManageRoomWidgets(
  client: MatrixClient | null,
  roomId: string,
): boolean {
  const room = client?.getRoom(roomId);
  const state = room ? liveRoomState(room) : undefined;
  return !!(
    client &&
    room?.getMyMembership() === 'join' &&
    !client.isGuest() &&
    state?.mayClientSendStateEvent(WIDGET_EVENT_TYPE, client)
  );
}
