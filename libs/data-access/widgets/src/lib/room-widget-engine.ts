import type { Observable } from 'rxjs';
import type { EngineResult } from '@trinity/util/matrix';
import type { RoomWidget } from './widget.model';

/** Account-and-room values a widget URL template may request. */
export interface WidgetIdentity {
  readonly userId: string;
  /** The room member's name, else the profile's, else the user id. */
  readonly displayName: string;
  /** An http(s) 96x96 crop, or `''` when there is no avatar. */
  readonly avatarUrl: string;
  readonly deviceId: string;
  readonly homeserverUrl: string;
}

/** One room's widget state, emitted whole: the list is small, so each emission is a reset. */
export interface RoomWidgetSnapshot {
  readonly widgets: readonly RoomWidget[];
  /** Joined, not a guest, and allowed to send widget state. */
  readonly canManage: boolean;
  /** `null` when the account is not live. */
  readonly identity: WidgetIdentity | null;
}

/** One `im.vector.modular.widgets` declaration as written to room state. */
export interface RoomWidgetStateContent {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly url: string;
  readonly creatorUserId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly waitForIframeLoad: boolean;
}

export interface RoomWidgetEngine {
  /**
   * The room's widgets, the account's permission to manage them and its identity: a
   * snapshot first, then a whole snapshot on every relevant change. An empty snapshot
   * when the account is not live. Never completes.
   */
  roomWidgets(
    accountId: string,
    roomId: string,
  ): Observable<RoomWidgetSnapshot>;
  /**
   * Writes one declaration under `content.id`. Fails `not-signed-in`, `forbidden`,
   * `state-key-taken` when room state already holds that id, or `request-failed`.
   */
  putRoomWidget(
    accountId: string,
    roomId: string,
    content: RoomWidgetStateContent,
  ): Observable<EngineResult<null>>;
  /**
   * Empties `widgetId`'s declaration only while its live revision is `expectedEventId`.
   * Fails `not-signed-in`, `forbidden`, `conflict`, `unsupported` for a call widget, or
   * `request-failed`. The check and the write are not atomic: a later write still wins.
   */
  removeRoomWidget(
    accountId: string,
    roomId: string,
    widgetId: string,
    expectedEventId: string,
  ): Observable<EngineResult<null>>;
}
