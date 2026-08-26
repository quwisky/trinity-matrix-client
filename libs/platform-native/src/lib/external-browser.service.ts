import { Injectable } from '@angular/core';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { Observable, catchError, defer, from, map, of } from 'rxjs';

/**
 * Opens an explicit third-party destination outside Trinity's app surface.
 *
 * Native uses Capacitor's browser controller; web uses a no-opener tab, and Electron's
 * hardened `setWindowOpenHandler` intercepts that same tab request and sends it to the OS.
 * Protocol validation is repeated here even when a caller already validated its model: a
 * platform boundary must not become a `javascript:` dispatch primitive after a future
 * call-site refactor.
 */
@Injectable({ providedIn: 'root' })
export class ExternalBrowserService {
  /** Returns false when the URL is unsafe/malformed or the platform dispatch fails. */
  open(url: string): Observable<boolean> {
    return defer(() => {
      if (!isSafeExternalUrl(url)) {
        return of(false);
      }
      if (Capacitor.isNativePlatform()) {
        return from(Browser.open({ url })).pipe(map(() => true));
      }

      window.open(url, '_blank', 'noopener,noreferrer');
      return of(true);
    }).pipe(
      catchError((error: unknown) => {
        logFailure(error);
        return of(false);
      }),
    );
  }
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function logFailure(error: unknown): void {
  console.debug('Trinity: external browser unavailable', error);
}
