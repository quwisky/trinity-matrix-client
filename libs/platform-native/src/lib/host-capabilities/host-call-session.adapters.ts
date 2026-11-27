import { Injectable } from '@angular/core';
import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from '@capacitor/core';
import { EMPTY, Observable } from 'rxjs';

const PLUGIN_NAME = 'CallSession';

interface CallSessionPlugin {
  /** Resolves `{ started: false }` when the host refuses the service; never rejects for that. */
  begin(options: { roomName: string }): Promise<unknown>;
  end(): Promise<void>;
  addListener(
    event: 'hangUp',
    listener: () => void,
  ): Promise<PluginListenerHandle>;
}

// Pure, so the bundler can drop the proxy from the startup closure when nothing reaches it.
const callSession =
  /* @__PURE__ */ registerPlugin<CallSessionPlugin>(PLUGIN_NAME);

/**
 * The calls capability's session host: on Android, the local `CallSession` plugin's foreground
 * service and its ongoing notification; on iOS, its audio session, which never asks to hang up;
 * nothing on a host without the plugin.
 */
@Injectable({ providedIn: 'root' })
export class NativeCallSessionAdapter {
  private readonly available =
    Capacitor.isNativePlatform() && Capacitor.isPluginAvailable(PLUGIN_NAME);

  readonly hangUpRequests: Observable<void> = this.available
    ? new Observable<void>((subscriber) => {
        const handle = callSession.addListener('hangUp', () =>
          subscriber.next(),
        );
        return () => void handle.then((listener) => listener.remove());
      })
    : EMPTY;

  async begin(info: { roomName: string }): Promise<void> {
    if (this.available) await callSession.begin({ roomName: info.roomName });
  }

  async end(): Promise<void> {
    if (this.available) await callSession.end();
  }
}
