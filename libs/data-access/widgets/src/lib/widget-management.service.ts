import { Injectable, inject } from '@angular/core';
import { type EngineFailure, EngineRequestError } from '@trinity/util/matrix';
import { Observable, defer, map, of, switchMap, take } from 'rxjs';
import { ROOM_WIDGET_ENGINE } from './room-widget-engine.token';
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
import { WidgetsService } from './widgets.service';

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

const ID_ATTEMPTS = 8;

/** Power-gated Tier 3 writes for generic legacy room widgets. */
@Injectable({ providedIn: 'root' })
export class WidgetManagementService {
  private readonly engine = inject(ROOM_WIDGET_ENGINE);
  private readonly widgets = inject(WidgetsService);

  /** Create one generic widget declaration. Cold: no validation or write until subscribe. */
  create(target: RoomWidgetTarget, draft: NewRoomWidget): Observable<string> {
    return this.engine.roomWidgets(target.accountId, target.roomId).pipe(
      take(1),
      switchMap(({ canManage, identity }) => {
        if (!identity) {
          throw new WidgetManagementError('not-signed-in');
        }
        if (!canManage) {
          throw new WidgetManagementError('forbidden');
        }
        const validated = validateRoomWidgetDraft(draft);
        if (!validated.value) {
          throw new WidgetManagementError('invalid-draft', validated.failure);
        }
        const randomUUID = globalThis.crypto?.randomUUID?.bind(
          globalThis.crypto,
        );
        if (!randomUUID) {
          throw new WidgetManagementError('uuid-unavailable');
        }
        const { name, rawUrl, origin } = validated.value;
        // A taken id is retried with a fresh UUID; never a predictable fallback.
        const attempt = (remaining: number): Observable<string> =>
          defer(() => {
            if (remaining === 0) {
              throw new WidgetManagementError('uuid-collision');
            }
            const id = randomUUID();
            const launch = this.widgets.launchFor(target, {
              id,
              name,
              type: CUSTOM_WIDGET_TYPE,
              rawUrl,
              data: {},
              creatorUserId: identity.userId,
              waitForIframeLoad: true,
              sourceEventId: null,
            });
            if (!launch.url || launch.insecure || launch.origin !== origin) {
              throw new WidgetManagementError(
                'invalid-draft',
                'dynamic-origin',
              );
            }
            return this.engine
              .putRoomWidget(target.accountId, target.roomId, {
                id,
                name,
                type: CUSTOM_WIDGET_TYPE,
                url: rawUrl,
                creatorUserId: identity.userId,
                data: {},
                waitForIframeLoad: true,
              })
              .pipe(
                switchMap((result) => {
                  if (result.ok) return of(id);
                  if (result.failure.code === 'state-key-taken') {
                    return attempt(remaining - 1);
                  }
                  throw errorFor(result.failure);
                }),
              );
          });
        return attempt(ID_ATTEMPTS);
      }),
    );
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
      return this.engine
        .removeRoomWidget(
          target.accountId,
          target.roomId,
          widget.id,
          widget.sourceEventId ?? '',
        )
        .pipe(
          map((result) => {
            if (!result.ok) throw errorFor(result.failure);
          }),
        );
    });
  }
}

/** The management error the feature words, else the engine failure as itself. */
function errorFor(failure: EngineFailure): Error {
  switch (failure.code) {
    case 'not-signed-in':
    case 'forbidden':
    case 'conflict':
      return new WidgetManagementError(failure.code);
    case 'unsupported':
      return new WidgetManagementError('unsupported-type');
    default:
      return new EngineRequestError(failure);
  }
}
