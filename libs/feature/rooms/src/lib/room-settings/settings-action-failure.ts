import { RoomAdministrationError } from '@trinity/data-access/room-administration';
import { describeMatrixRequestFailure } from '@trinity/util/matrix';

/**
 * Plain words for a failed Room settings action: the service's own explanation when it
 * refused the action, otherwise the request failure without any server text.
 */
export function settingsActionFailure(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof RoomAdministrationError) {
    const { failure } = error.outcome;
    if (failure === 'permission-denied' || failure === 'invalid-input') {
      return error.message;
    }
    if (error.cause !== undefined) {
      return describeMatrixRequestFailure(error.cause, fallback).message;
    }
  }
  return describeMatrixRequestFailure(error, fallback).message;
}
