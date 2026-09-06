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
import type {
  NewRoomWidget,
  RoomWidget,
  RoomWidgetTarget,
} from './widget.model';
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
  create(target: RoomWidgetTarget, draft: NewRoomWidget): Observable<string> {
    return defer(() => {
      const context = this.context(target);
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
      const launch = this.widgets.launchFor(target, widget);
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
          target.roomId,
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
  remove(target: RoomWidgetTarget, widget: RoomWidget): Observable<void> {
    return defer(() => {
      if (isCallWidgetType(widget.type)) {
        throw new WidgetManagementError('unsupported-type');
      }
      const context = this.context(target);
      const current = context.state.getStateEvents(
        WIDGET_EVENT_TYPE,
        widget.id,
      ) as MatrixEvent | null;
      const currentType = current ? activeWidgetType(current) : null;
      if (
        !widget.sourceEventId ||
        !current?.getId() ||
        current.getId() !== widget.sourceEventId ||
        !currentType
      ) {
        throw new WidgetManagementError('conflict');
      }
      if (isCallWidgetType(currentType)) {
        throw new WidgetManagementError('unsupported-type');
      }
      return from(
        sendWidgetStateEvent(context.client, target.roomId, {}, widget.id),
      ).pipe(map(() => void 0));
    });
  }

  private context(target: RoomWidgetTarget): ManagementContext {
    const client = this.matrix.clientFor(target.accountId);
    if (!client) {
      throw new WidgetManagementError('not-signed-in');
    }
    const room = client.getRoom(target.roomId);
    const state = room ? liveRoomState(room) : undefined;
    const userId = client.getUserId();
    if (!room || !state || !userId) {
      throw new WidgetManagementError('not-signed-in');
    }
    if (!canManageRoomWidgets(client, target.roomId)) {
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
