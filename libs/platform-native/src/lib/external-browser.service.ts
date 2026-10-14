import { Injectable, inject } from '@angular/core';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { HostBrowserSheetService } from '@trinity/runtime/host';
import { Observable, catchError, defer, from, map, of, tap } from 'rxjs';
import { browserSheetClosed } from './browser-sheet-closed';

/**
 * Opens an explicit third-party destination outside Trinity's app surface.
 *
 * Native uses Capacitor's browser controller; web uses a no-opener tab, and Electron's
 * hardened `setWindowOpenHandler` intercepts that same tab request and sends it to the OS.
 * Protocol validation is repeated here even when a caller already validated its model: a
 * platform boundary must not become a `javascript:` dispatch primitive after a future
 * call-site refactor.
 *
 * The native sheet is Trinity's own system UI, counted like the sign-in sheet so App lock never
 * locks behind it; the web and desktop browsers are outside Trinity.
 */
@Injectable({ providedIn: 'root' })
export class ExternalBrowserService {
  private readonly sheet = inject(HostBrowserSheetService);

  /** Returns false when the URL is unsafe/malformed or the platform dispatch fails. */
  open(url: string): Observable<boolean> {
    return defer(() => {
      if (!isSafeExternalUrl(url)) {
        return of(false);
      }
      if (Capacitor.isNativePlatform()) {
        // From before the sheet shows: the plugin's open resolves only once it is up.
        this.sheet.begin(browserSheetClosed);
        return from(Browser.open({ url })).pipe(
          map(() => true),
          tap({ error: () => this.sheet.end() }),
        );
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
