import type { PluginListenerHandle } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { Observable } from 'rxjs';

/**
 * Emits each time the person closes the Capacitor browser sheet (Custom Tabs, Safari View
 * Controller). A listener that fails to attach stays silent: the sheet's other ends still
 * close its count in `HostBrowserSheetService`.
 */
export const browserSheetClosed = new Observable<void>((subscriber) => {
  let handle: PluginListenerHandle | undefined;
  let cancelled = false;
  void Browser.addListener('browserFinished', () => subscriber.next())
    .then((value) => {
      handle = value;
      if (cancelled) void value.remove().catch(() => undefined);
    })
    .catch(() => undefined);
  return () => {
    cancelled = true;
    if (handle) void handle.remove().catch(() => undefined);
  };
});
