import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainEvent } from 'electron';
import type { MenuOptions } from './menu';

// preload.ts mirrors these by string value.
export const LOCK_SET_STATE_CHANNEL =
  'trinity:host:v1:lock-integration:set-state';
export const LOCK_COVER_PAINTED_CHANNEL =
  'trinity:host:v1:lock-integration:cover-painted';
export const LOCK_REQUEST_CHANNEL = 'trinity:host:v1:lock-integration:request';

/** How long a shown window waits, transparent, for the renderer to paint the cover. */
export const SHOW_HOLD_TIMEOUT_MS = 700;

/** Electron accelerators are `Modifier+Key`; anything else is shown without a shortcut. */
const ACCELERATOR = /^[A-Za-z0-9]+(?:\+[A-Za-z0-9`\-=[\];',./\\]+)*$/;

export interface LockState {
  readonly enabled: boolean;
  readonly locked: boolean;
  readonly accelerator: string | null;
}

export interface LockIntegrationDeps {
  readonly buildMenu: (options: MenuOptions) => void;
  readonly packaged: boolean;
  readonly powerMonitor: Pick<NodeJS.EventEmitter, 'on'>;
  readonly getMainWindow: () => BrowserWindow | null;
}

/**
 * The renderer's lock state, or null when `enabled` or `locked` is malformed. A shortcut
 * main can't display becomes null instead: dropping the whole state would also drop the
 * menu item and the OS lock and sleep forwarding.
 */
export function parseLockState(raw: unknown): LockState | null {
  if (!raw || typeof raw !== 'object') return null;
  const { enabled, locked, accelerator } = raw as Record<string, unknown>;
  if (typeof enabled !== 'boolean' || typeof locked !== 'boolean') return null;
  const displayable =
    typeof accelerator === 'string' &&
    accelerator.length <= 64 &&
    ACCELERATOR.test(accelerator);
  return { enabled, locked, accelerator: displayable ? accelerator : null };
}

/**
 * Wire `lock-integration`: the "Lock Trinity" menu item, OS lock and sleep, and the hold
 * that keeps a window shown again transparent until the renderer has painted. Serves only
 * the main window's renderer; a throw in an `ipcMain.on` listener would raise the main
 * process's error dialog, so nothing here throws.
 */
export function registerLockIntegration(deps: LockIntegrationDeps): void {
  let state: LockState = { enabled: false, locked: false, accelerator: null };
  // The show hold: 'concealed' while hidden or minimised (a painted signal then is ignored,
  // as the frame may be replaced again before the window shows), 'revealing' once shown
  // again (the next painted signal or the timeout reveals it).
  let hold: 'none' | 'concealed' | 'revealing' = 'none';
  let reveal: ReturnType<typeof setTimeout> | null = null;
  const watched = new WeakSet<BrowserWindow>();

  const trusted = (event: IpcMainEvent): BrowserWindow | null => {
    const win = deps.getMainWindow();
    return win && event.sender === win.webContents ? win : null;
  };
  const request = (kind: 'menu' | 'system-locked' | 'suspended'): void => {
    const win = deps.getMainWindow();
    if (state.enabled && win && !win.isDestroyed()) {
      win.webContents.send(LOCK_REQUEST_CHANNEL, kind);
    }
  };
  const cancelReveal = (): void => {
    if (reveal) clearTimeout(reveal);
    reveal = null;
  };
  const setOpacity = (win: BrowserWindow, opacity: number): void => {
    try {
      win.setOpacity(opacity);
    } catch {
      // A window being destroyed; nothing to hide or reveal.
    }
  };
  const show = (win: BrowserWindow): void => {
    cancelReveal();
    hold = 'none';
    setOpacity(win, 1);
  };
  const watch = (win: BrowserWindow): void => {
    if (watched.has(win)) return;
    watched.add(win);
    const conceal = (): void => {
      if (!state.enabled) return;
      cancelReveal();
      hold = 'concealed';
      setOpacity(win, 0);
    };
    const shown = (): void => {
      if (hold !== 'concealed') return;
      hold = 'revealing';
      reveal = setTimeout(() => show(win), SHOW_HOLD_TIMEOUT_MS);
    };
    // Some restores emit neither show nor restore (e.g. a minimised maximised window on
    // Windows may emit only maximize); start the reveal once the window is visible anyway.
    const maybeShown = (): void => {
      try {
        if (win.isVisible() && !win.isMinimized()) shown();
      } catch {
        // A window being destroyed; nothing to reveal.
      }
    };
    win.on('hide', conceal);
    win.on('minimize', conceal);
    win.on('show', shown);
    win.on('restore', shown);
    win.on('maximize', maybeShown);
    win.on('focus', maybeShown);
  };
  const rebuild = (): void => {
    deps.buildMenu({
      packaged: deps.packaged,
      lock: {
        visible: state.enabled,
        enabled: state.enabled && !state.locked,
        accelerator: state.accelerator,
        onLock: () => request('menu'),
      },
    });
  };

  const initial = deps.getMainWindow();
  if (initial) watch(initial);

  ipcMain.on(LOCK_SET_STATE_CHANNEL, (event, raw: unknown) => {
    const win = trusted(event);
    const next = parseLockState(raw);
    if (!win || !next) return;
    watch(win);
    state = next;
    try {
      rebuild();
    } catch {
      // Keep the previous menu.
    }
  });

  ipcMain.on(LOCK_COVER_PAINTED_CHANNEL, (event) => {
    const win = trusted(event);
    // Only once the window is showing again: a cover painted while hidden (an OS lock, sleep
    // or a renderer-recovery reload) says nothing about the frame the next show reveals.
    if (win && hold === 'revealing') show(win);
  });

  deps.powerMonitor.on('lock-screen', () => request('system-locked'));
  deps.powerMonitor.on('suspend', () => request('suspended'));
}
