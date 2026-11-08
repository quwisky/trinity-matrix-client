import { effect, untracked, type Injector } from '@angular/core';
import { Observable } from 'rxjs';

/**
 * A signal read as a stream of its values, for as long as it is subscribed. Unlike
 * `toObservable`, whose watcher lives until its injector is destroyed, unsubscribing ends the
 * watcher, so a root service can call this per wait or per observation without leaking. The
 * first value is read when the effect first runs, never replayed from an earlier subscriber.
 */
export function signalChanges<T>(
  read: () => T,
  injector: Injector,
): Observable<T> {
  return new Observable<T>((subscriber) => {
    const ref = effect(
      () => {
        const value = read();
        untracked(() => subscriber.next(value));
      },
      { injector },
    );
    return () => ref.destroy();
  });
}
