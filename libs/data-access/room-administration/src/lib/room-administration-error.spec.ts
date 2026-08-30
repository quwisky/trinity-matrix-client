import { firstValueFrom, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  RoomAdministrationError,
  recoverRoomAdministrationRequest,
} from './room-administration-error';
import { RoomActionPermissionError } from './room-action-permissions.service';

describe('Room Administration recovery outcomes', () => {
  it('classifies a homeserver rejection without leaking its payload', async () => {
    const error = await firstValueFrom(
      throwError(() => new Error('M_FORBIDDEN')).pipe(
        recoverRoomAdministrationRequest('set-room-name'),
      ),
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RoomAdministrationError);
    expect((error as RoomAdministrationError).outcome).toEqual({
      kind: 'rejected',
      failure: 'server-rejected',
      recovery: 'retry-operation',
      operation: 'set-room-name',
    });
  });

  it('marks a failed second step as a partial update', async () => {
    const error = await firstValueFrom(
      throwError(() => new Error('state write failed')).pipe(
        recoverRoomAdministrationRequest('set-avatar', {
          completedStep: 'media-upload',
        }),
      ),
    ).catch((cause: unknown) => cause);

    expect((error as RoomAdministrationError).outcome).toEqual({
      kind: 'rejected',
      failure: 'partial-update',
      recovery: 'review-room-state',
      operation: 'set-avatar',
      completedStep: 'media-upload',
    });
  });

  it('types a permission denial as a request to refresh live authority', () => {
    const error = new RoomActionPermissionError({
      available: false,
      reason: 'Your role changed.',
    });

    expect(error.outcome).toEqual({
      kind: 'rejected',
      failure: 'permission-denied',
      recovery: 'refresh-authority',
      operation: 'authorize-room-action',
    });
  });

  it('reports a late permission denial as partial after an earlier step completed', async () => {
    const error = await firstValueFrom(
      throwError(
        () =>
          new RoomActionPermissionError({
            available: false,
            reason: 'Your role changed.',
          }),
      ).pipe(
        recoverRoomAdministrationRequest('set-avatar', {
          completedStep: 'media-upload',
        }),
      ),
    ).catch((cause: unknown) => cause);

    expect((error as RoomAdministrationError).outcome).toEqual({
      kind: 'rejected',
      failure: 'partial-update',
      recovery: 'review-room-state',
      operation: 'set-avatar',
      completedStep: 'media-upload',
    });
  });
});
