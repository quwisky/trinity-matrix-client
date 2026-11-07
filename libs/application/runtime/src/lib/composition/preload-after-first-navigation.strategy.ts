import { Injectable } from '@angular/core';
import { type PreloadingStrategy, type Route } from '@angular/router';
import { Observable, switchMap } from 'rxjs';

/** A busy main thread (Matrix sync) cannot push preloading back further than this. */
const IDLE_TIMEOUT_MS = 2_000;

/** Safari has no `requestIdleCallback`; a short timeout stands in for it. */
function idle(): Observable<void> {
  return new Observable<void>((subscriber) => {
    const done = (): void => {
      subscriber.next();
      subscriber.complete();
    };
    if (typeof requestIdleCallback === 'function') {
      const handle = requestIdleCallback(done, {
        timeout: IDLE_TIMEOUT_MS,
      });
      return () => cancelIdleCallback(handle);
    }
    const handle = setTimeout(done, 200);
    return () => clearTimeout(handle);
  });
}

/**
 * Preloads every lazy route like `PreloadAllModules`, but on idle. The router asks for preloads
 * after each navigation ends, so the first call comes once the first Room has rendered.
 */
@Injectable({ providedIn: 'root' })
export class PreloadAfterFirstNavigation implements PreloadingStrategy {
  preload(_route: Route, load: () => Observable<unknown>): Observable<unknown> {
    return idle().pipe(switchMap(load));
  }
}
