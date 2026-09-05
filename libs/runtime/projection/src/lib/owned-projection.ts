import { Observable } from 'rxjs';

/** Build a cold projection lifetime that pairs attachment with exact cleanup. */
export function ownedProjection(
  attach: () => void,
  release: () => void,
): Observable<void> {
  return new Observable<void>((subscriber) => {
    try {
      attach();
    } catch (error: unknown) {
      try {
        release();
      } catch (cleanupError: unknown) {
        subscriber.error(
          new AggregateError(
            [error, cleanupError],
            'Projection attachment and cleanup failed.',
          ),
        );
        return;
      }
      subscriber.error(error);
      return;
    }
    subscriber.next();
    return release;
  });
}
