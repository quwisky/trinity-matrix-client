import { Injectable, inject } from '@angular/core';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import {
  describeMatrixRequestFailure,
  initialOf,
  unwrapEngineResult,
  type MatrixLinkTarget,
} from '@trinity/util/matrix';
import { Observable, defer, map, throwError } from 'rxjs';
import {
  DISCOVERY_ENGINE,
  type RoomLinkJoinRule,
  type RoomLinkMembership,
  type RoomLinkPreviewData,
} from './discovery-engine';

export type RoomLinkAction = 'open' | 'accept' | 'join' | 'knock' | 'none';

/** Information safe to project into the room-link preview UI. */
export interface RoomLinkPreview {
  /** Account whose Matrix client resolved this preview and must perform its action. */
  readonly accountId: string;
  readonly roomId: string;
  readonly requestedAddress: string | null;
  readonly canonicalAddress: string | null;
  readonly name: string;
  readonly initial: string;
  readonly topic: string | null;
  readonly avatarMxc: string | null;
  readonly memberCount: number | null;
  readonly encrypted: boolean | null;
  readonly joinRule: RoomLinkJoinRule;
  readonly membership: RoomLinkMembership;
  readonly action: RoomLinkAction;
  readonly isSpace: boolean;
  readonly via: readonly string[];
}

/** Error state shown by a failed room preview. */
export interface RoomLinkPreviewFailure {
  readonly title: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** Exhaustive action mapping: never offer a membership write that cannot be justified. */
export function roomLinkAction(
  membership: RoomLinkMembership,
  joinRule: RoomLinkJoinRule,
  restrictedEligible = false,
): RoomLinkAction {
  if (membership === 'join') return 'open';
  if (membership === 'invite') return 'accept';
  if (membership !== 'leave' && membership !== 'unknown') return 'none';
  if (
    joinRule === 'public' ||
    ((joinRule === 'restricted' || joinRule === 'knock_restricted') &&
      restrictedEligible)
  ) {
    return 'join';
  }
  if (joinRule === 'knock' || joinRule === 'knock_restricted') return 'knock';
  return 'none';
}

/** Map request failures to room-specific, privacy-safe copy. */
export function describeRoomLinkPreviewFailure(
  error: unknown,
): RoomLinkPreviewFailure {
  const failure = describeMatrixRequestFailure(
    error,
    'This room could not be previewed. Try again.',
  );
  if (failure.diagnostic.httpStatus === 404) {
    return {
      title: 'Room not found',
      message: 'This room address is unknown or no longer exists.',
      retryable: false,
    };
  }
  if (failure.kind === 'permission') {
    return {
      title: 'Room unavailable',
      message: 'This room does not allow its information to be previewed.',
      retryable: false,
    };
  }
  if (failure.kind === 'network' || failure.kind === 'timeout') {
    return {
      title: 'Could not connect',
      message: failure.message,
      retryable: true,
    };
  }
  if (failure.kind === 'server' || failure.kind === 'rate-limit') {
    return {
      title: 'Homeserver unavailable',
      message: failure.message,
      retryable: true,
    };
  }
  return {
    title: 'Could not preview room',
    message: failure.message,
    retryable: true,
  };
}

function toPreview(
  accountId: string,
  requested: string,
  { restrictedEligible, ...data }: RoomLinkPreviewData,
): RoomLinkPreview {
  return {
    ...data,
    accountId,
    requestedAddress: requested.startsWith('#') ? requested : null,
    initial: initialOf(data.name),
    action: roomLinkAction(data.membership, data.joinRule, restrictedEligible),
  };
}

/** Resolves room links into preview data and performs the explicit membership actions. Cold. */
@Injectable({ providedIn: 'root' })
export class RoomLinkService {
  private readonly engine = inject(DISCOVERY_ENGINE);
  private readonly session = inject(SessionStateService);

  preview(
    target: Extract<MatrixLinkTarget, { kind: 'room' }>,
    accountId?: string,
  ): Observable<RoomLinkPreview> {
    return defer(() => {
      // An invite row names its own account; a pasted link previews as the active one.
      const id = accountId ?? this.session.activeAccountId();
      if (!id) return throwError(() => new Error('Not signed in.'));
      return this.engine
        .previewRoom(id, target.roomIdOrAlias, target.via ?? [])
        .pipe(
          unwrapEngineResult(),
          map((data) => toPreview(id, target.roomIdOrAlias, data)),
        );
    });
  }

  /** Join only after the preview's explicit Join action is pressed. */
  join(preview: RoomLinkPreview): Observable<string> {
    return this.engine
      .joinRoom(preview.accountId, preview.roomId, preview.via)
      .pipe(
        unwrapEngineResult(),
        map(({ roomId }) => roomId),
      );
  }

  /** Request access only after the preview's explicit knock action is pressed. */
  knock(preview: RoomLinkPreview): Observable<void> {
    return this.engine
      .knockRoom(preview.accountId, preview.roomId, preview.via, null)
      .pipe(
        unwrapEngineResult(),
        map(() => undefined),
      );
  }
}
