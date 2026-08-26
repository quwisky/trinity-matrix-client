import {
  Injectable,
  type Signal,
  type WritableSignal,
  inject,
  signal,
} from '@angular/core';
import {
  type MatrixClient,
  type MatrixEvent,
  RoomStateEvent,
} from 'matrix-js-sdk';
import {
  MatrixClientService,
  projectFromClient,
} from '@trinity/data-access/matrix-client';
import { ThemeService } from '@trinity/platform-native';
import { liveRoomState } from '@trinity/util/matrix';
import type {
  RoomWidget,
  WidgetLaunch,
  WidgetTemplateContext,
} from './widget.model';
import { resolveWidgetLaunch } from './widget-template';

/** The legacy room-state event used by deployed Matrix widgets. */
export const WIDGET_EVENT_TYPE = 'im.vector.modular.widgets';
const TRINITY_WIDGET_CLIENT_ID = 'eu.qwky.trinity';

interface WatchedRoom {
  readonly state: WritableSignal<readonly RoomWidget[]>;
  consumers: number;
}

/**
 * Demand-driven projection of the widgets declared in rooms whose settings dialog has
 * asked for them. Tier 1 deliberately stops at discovery and an external browser link —
 * no iframe, postMessage bridge, decrypted events, or widget writes live here.
 */
@Injectable({ providedIn: 'root' })
export class WidgetsService {
  private readonly matrix = inject(MatrixClientService);
  private readonly theme = inject(ThemeService);
  private readonly watched = new Map<string, WatchedRoom>();

  private readonly onStateEvent = (event: MatrixEvent): void => {
    const roomId = event.getRoomId();
    if (
      event.getType() === WIDGET_EVENT_TYPE &&
      roomId &&
      this.watched.has(roomId)
    ) {
      this.projection.schedule();
    }
  };

  private readonly projection = projectFromClient({
    matrix: this.matrix,
    bind: (client) => client.on(RoomStateEvent.Events, this.onStateEvent),
    unbind: (client) => client.off(RoomStateEvent.Events, this.onStateEvent),
    rebuild: (client) => {
      for (const [roomId, watched] of this.watched) {
        watched.state.set(readRoomWidgets(client, roomId));
      }
    },
    reset: () => {
      for (const watched of this.watched.values()) {
        watched.state.set([]);
      }
    },
  });

  /**
   * Widgets currently declared in one room. The signal is memoized and synchronously
   * seeded, so the dialog does not flash an empty state before its first render.
   */
  widgetsFor(roomId: string): Signal<readonly RoomWidget[]> {
    return this.watchedRoom(roomId).state.asReadonly();
  }

  /** Acquire one room and attach the shared filtered listener for the first consumer. */
  connect(roomId: string): void {
    this.watchedRoom(roomId).consumers += 1;
    this.projection.connect();
  }

  /** Release one consumer without disrupting another open room-settings dialog. */
  disconnect(roomId: string): void {
    const watched = this.watched.get(roomId);
    if (!watched) {
      return;
    }
    watched.consumers = Math.max(0, watched.consumers - 1);
    if (watched.consumers > 0) {
      return;
    }
    watched.state.set([]);
    this.watched.delete(roomId);
    if (this.watched.size === 0) {
      this.projection.disconnect();
    }
  }

  /** Expand and validate a widget destination using the current account and client UI. */
  launchFor(roomId: string, widget: RoomWidget): WidgetLaunch {
    return resolveWidgetLaunch(widget, this.templateContext(roomId));
  }

  private readClient(): MatrixClient | null {
    return (
      this.projection.client() ??
      (this.matrix.isInitialized ? this.matrix.instance : null)
    );
  }

  private watchedRoom(roomId: string): WatchedRoom {
    let watched = this.watched.get(roomId);
    if (!watched) {
      watched = {
        state: signal<readonly RoomWidget[]>(
          readRoomWidgets(this.readClient(), roomId),
          { equal: sameWidgets },
        ),
        consumers: 0,
      };
      this.watched.set(roomId, watched);
    }
    return watched;
  }

  private templateContext(roomId: string): WidgetTemplateContext {
    // Reading the signal makes every computed launch URL account-scoped. The active
    // instance changes synchronously with it, while the room-state projection reconnects
    // in an effect and may otherwise keep an identical widget array referentially stable.
    const activeUserId = this.matrix.activeUserId();
    const client =
      activeUserId && this.matrix.isInitialized ? this.matrix.instance : null;
    const userId = client?.getUserId() ?? activeUserId ?? '';
    const roomMember = userId
      ? client?.getRoom(roomId)?.getMember(userId)
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
      roomId,
      userId,
      displayName: roomMember?.rawDisplayName ?? user?.displayName ?? userId,
      avatarUrl,
      clientId: TRINITY_WIDGET_CLIENT_ID,
      theme: this.theme.resolved(),
      language: typeof navigator === 'undefined' ? '' : navigator.language,
      deviceId: client?.getDeviceId() ?? '',
      baseUrl: client?.getHomeserverUrl() ?? '',
    };
  }
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
        JSON.stringify(widget.data) === JSON.stringify(right[index]?.data),
    )
  );
}
