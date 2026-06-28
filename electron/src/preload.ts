import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

/**
 * Minimal, non-privileged preload bridge.
 *
 * Runs in a sandboxed, context-isolated world. We do NOT hand the renderer raw
 * Node, the filesystem, or `ipcRenderer` itself — only a small, explicit API
 * surface so the Angular app can (a) detect that it is running inside the
 * hand-rolled Electron desktop shell (used e.g. to keep the service worker off)
 * and (b) receive OS deep links forwarded by the main process.
 *
 * Detection contract (consumed by apps/trinity/src/main.ts):
 *   (globalThis as any).trinityDesktop?.isElectron === true
 *
 * Deep-link contract (consumed by apps/trinity/src/app/app.component.ts):
 *   trinityDesktop.onDeepLink(cb) subscribes to `eu.qwky.trinity://…` URLs that
 *   the main process forwards over the `deep-link` ipcRenderer channel (used for
 *   the desktop SSO callback) and returns an unsubscribe function. Only the URL
 *   string is passed to the callback — the raw IpcRendererEvent is never leaked.
 */
const DEEP_LINK_CHANNEL = 'deep-link';

// Listen at preload load (before any page JS), buffering URLs that arrive before
// the renderer subscribes. The main process flushes a cold-start deep link on
// `did-finish-load`, which can precede Angular's `onDeepLink` registration in
// ngOnInit — without this buffer that URL would be lost.
const buffered: string[] = [];
let active: ((url: string) => void) | null = null;

ipcRenderer.on(DEEP_LINK_CHANNEL, (_event: IpcRendererEvent, url: string): void => {
  if (typeof url !== 'string') {
    return;
  }
  if (active) {
    active(url);
  } else {
    buffered.push(url);
  }
});

contextBridge.exposeInMainWorld('trinityDesktop', {
  isElectron: true,
  platform: process.platform,
  onDeepLink(callback: (url: string) => void): () => void {
    active = callback;
    // Replay anything that arrived before the renderer subscribed.
    while (buffered.length > 0) {
      callback(buffered.shift() as string);
    }
    return () => {
      if (active === callback) {
        active = null;
      }
    };
  },
});
