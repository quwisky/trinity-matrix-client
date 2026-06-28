import { contextBridge } from 'electron';

/**
 * Minimal, non-privileged preload bridge.
 *
 * Runs in a sandboxed, context-isolated world. We expose NOTHING that grants the
 * renderer access to Node, IPC, or the filesystem — only a small, read-only
 * marker so the Angular app can reliably detect that it is running inside the
 * hand-rolled Electron desktop shell (used e.g. to keep the service worker off).
 *
 * Detection contract (consumed by apps/trinity/src/main.ts):
 *   (globalThis as any).trinityDesktop?.isElectron === true
 */
contextBridge.exposeInMainWorld('trinityDesktop', {
  isElectron: true,
  platform: process.platform,
});
