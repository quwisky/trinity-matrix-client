import { InjectionToken, inject } from '@angular/core';
import { NativeCallSessionAdapter } from '@trinity/platform-native';
import type { Observable } from 'rxjs';

/**
 * What the host does to keep a joined call alive while Trinity is in the background (Android:
 * a foreground service with an ongoing notification). `end` follows every `begin`.
 */
export interface CallSessionHost {
  begin(info: { roomName: string }): Promise<void>;
  end(): Promise<void>;
  /** The host's own Hang up control (the notification's action). */
  readonly hangUpRequests: Observable<void>;
}

/**
 * Defaults to the native adapter, which does nothing on a host without the plugin. Provided
 * here rather than at the composition root, which would pull this library into startup.
 */
export const CALL_SESSION_HOST = new InjectionToken<CallSessionHost>(
  'CALL_SESSION_HOST',
  {
    providedIn: 'root',
    factory: (): CallSessionHost => inject(NativeCallSessionAdapter),
  },
);
