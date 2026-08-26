import { Injectable, inject } from '@angular/core';
import type { MatrixClient, MatrixEvent, Room, RoomState } from 'matrix-js-sdk';
import { Observable, defer, from, map } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { liveRoomState } from '@trinity/util/matrix';
import { isCallWidgetType } from './widget-embed-policy';
import {
  CUSTOM_WIDGET_TYPE,
  type WidgetDraftFailure,
  validateRoomWidgetDraft,
} from './widget-management-policy';
import type { NewRoomWidget, RoomWidget } from './widget.model';
import {
  WIDGET_EVENT_TYPE,
  WidgetsService,
  canManageRoomWidgets,
} from './widgets.service';

export type WidgetManagementFailure =
  | 'not-signed-in'
  | 'forbidden'
  | 'invalid-draft'
  | 'uuid-unavailable'
  | 'uuid-collision'
  | 'conflict'
  | 'unsupported-type';

/** A stable failure contract so feature copy does not inspect SDK/server messages. */
export class WidgetManagementError extends Error {
  constructor(
    readonly code: WidgetManagementFailure,
    readonly draftFailure?: WidgetDraftFailure,
  ) {
    super(code);
    this.name = 'WidgetManagementError';
  }
}

interface ManagementContext {
  readonly client: MatrixClient;
  readonly room: Room;
  readonly state: RoomState;
  readonly userId: string;
}

/** Power-gated Tier 3 writes for generic legacy room widgets. */
@Injectable({ providedIn: 'root' })
export class WidgetManagementService {
  private readonly matrix = inject(MatrixClientService);
  private readonly widgets = inject(WidgetsService);

  /** Create one generic widget declaration. Cold: no validation or write until subscribe. */
  create(roomId: string, draft: NewRoomWidget): Observable<string> {
    return defer(() => {
      const context = this.context(roomId);
      const validated = validateRoomWidgetDraft(draft);
      if (!validated.value) {
        throw new WidgetManagementError('invalid-draft', validated.failure);
      }
      const id = this.unusedId(context.state);
      const widget: RoomWidget = {
        id,
        name: validated.value.name,
        type: CUSTOM_WIDGET_TYPE,
        rawUrl: validated.value.rawUrl,
        data: {},
        creatorUserId: context.userId,
        waitForIframeLoad: true,
        sourceEventId: null,
      };
      const launch = this.widgets.launchFor(roomId, widget);
      if (
        !launch.url ||
        launch.insecure ||
        launch.origin !== validated.value.origin
      ) {
        throw new WidgetManagementError('invalid-draft', 'dynamic-origin');
      }
      return from(
        sendWidgetStateEvent(
          context.client,
          roomId,
          {
            id,
            name: validated.value.name,
            type: CUSTOM_WIDGET_TYPE,
            url: validated.value.rawUrl,
            creatorUserId: context.userId,
            data: {},
            waitForIframeLoad: true,
          },
          id,
        ),
      ).pipe(map(() => id));
    });
  }

  /**
   * Tombstone the exact revision the administrator confirmed. Matrix state writes are
   * last-write-wins, so a replacement after this local check remains a server-level race.
   */
  remove(roomId: string, widget: RoomWidget): Observable<void> {
    return defer(() => {
      if (isCallWidgetType(widget.type)) {
        throw new WidgetManagementError('unsupported-type');
      }
      const context = this.context(roomId);
      const current = context.state.getStateEvents(
        WIDGET_EVENT_TYPE,
        widget.id,
      ) as MatrixEvent | null;
      if (
        !widget.sourceEventId ||
        !current?.getId() ||
        current.getId() !== widget.sourceEventId ||
        !isActiveWidget(current)
      ) {
        throw new WidgetManagementError('conflict');
      }
      return from(
        sendWidgetStateEvent(context.client, roomId, {}, widget.id),
      ).pipe(map(() => void 0));
    });
  }

  private context(roomId: string): ManagementContext {
    if (!this.matrix.isInitialized) {
      throw new WidgetManagementError('not-signed-in');
    }
    const client = this.matrix.instance;
    const room = client.getRoom(roomId);
    const state = room ? liveRoomState(room) : undefined;
    const userId = client.getUserId();
    if (!room || !state || !userId) {
      throw new WidgetManagementError('not-signed-in');
    }
    if (!canManageRoomWidgets(client, roomId)) {
      throw new WidgetManagementError('forbidden');
    }
    return { client, room, state, userId };
  }

  private unusedId(state: RoomState): string {
    const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
    if (!randomUUID) {
      throw new WidgetManagementError('uuid-unavailable');
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = randomUUID();
      if (!state.getStateEvents(WIDGET_EVENT_TYPE, id)) {
        return id;
      }
    }
    throw new WidgetManagementError('uuid-collision');
  }
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

function isActiveWidget(event: MatrixEvent): boolean {
  const content: unknown = event.getContent();
  return !!(
    content &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    typeof (content as Record<string, unknown>)['type'] === 'string' &&
    typeof (content as Record<string, unknown>)['url'] === 'string'
  );
}
