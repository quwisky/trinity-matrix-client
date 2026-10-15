import { Observable } from 'rxjs';

/**
 * Emits once, then completes, when what is on screen now has painted: the first animation frame
 * lays it out, the second has painted it. App lock's `cover-painted` signal waits on this, so the
 * shell never reveals a window before its lock screen is on it. Unsubscribing cancels the wait.
 */
export function afterPaint(view: Window): Observable<void> {
  return new Observable<void>((subscriber) => {
    let frame = view.requestAnimationFrame(() => {
      frame = view.requestAnimationFrame(() => {
        subscriber.next();
        subscriber.complete();
      });
    });
    return () => view.cancelAnimationFrame(frame);
  });
}
