import { app, ipcMain, nativeImage } from 'electron';
import * as fs from 'node:fs';
import { iconCandidatePaths } from './icons';
import { getMainWindow } from './window';

// Dock / launcher / taskbar unread badge.
//   renderer -> main (`ipcMain.on`, one-way): SET_BADGE_COUNT_CHANNEL pushes the
//     app-wide unread total. The payload is UNTRUSTED — it is fully validated and
//     clamped (coerceBadgeCount) before it drives any native badge.
//
// Platform split (see applyBadgeCount):
//   macOS / Linux(Unity): `app.setBadgeCount` draws the numeric dock/launcher
//     count. A count of `0` clears it.
//   Windows: there is NO numeric taskbar badge — the closest native affordance
//     is a small OVERLAY ICON on the taskbar button (BrowserWindow.setOverlayIcon).
//     We show a red "unread present" dot for count > 0 and clear it at 0. The
//     exact count can't be rendered reliably (see resolveOverlayIcon), so it is
//     carried in the overlay's accessibility description ("5 unread" / "99+ unread").
export const SET_BADGE_COUNT_CHANNEL = 'set-badge-count';

/** Upper bound for the displayed badge; larger totals are clamped to it. */
export const MAX_BADGE_COUNT = 9999;

// Lazily resolved red-dot overlay image for the Windows taskbar. `undefined` =>
// not yet resolved; `null` => none found (we then skip drawing an overlay).
let overlayIconCache: Electron.NativeImage | null | undefined;

/**
 * Validate + clamp an UNTRUSTED badge count from the renderer. It must be a
 * finite number; it is floored to an integer and clamped to
 * `[0, MAX_BADGE_COUNT]`. Returns `null` for anything malformed (non-number,
 * `NaN`, `Infinity`) so the caller leaves the current badge untouched.
 */
export function coerceBadgeCount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null;
  }
  return Math.min(Math.max(Math.floor(raw), 0), MAX_BADGE_COUNT);
}

/**
 * Short, human-readable form of a (already-clamped) count for the Windows
 * overlay description — a taskbar overlay can only convey ~3 characters, so
 * anything past 99 collapses to `99+`.
 */
export function formatBadgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * Red-dot overlay image for the Windows taskbar, resolved once and cached.
 *
 * Rendering choice — why a bundled PNG rather than a generated numbered badge:
 * Electron's `nativeImage.createFromDataURL` decodes PNG/JPEG only; it does NOT
 * rasterize SVG (an `image/svg+xml` data URL yields an EMPTY image, verified on
 * Electron 42), and there is no canvas/font rasterizer in the main process. A
 * generated numbered badge would therefore be unreliable. So we ship a small,
 * self-contained red-dot PNG ("unread present", no number) and put the actual
 * count in the overlay's accessibility description instead. Returns `undefined`
 * when the asset can't be found so we skip drawing rather than pass a blank image.
 */
function resolveOverlayIcon(): Electron.NativeImage | undefined {
  if (overlayIconCache === undefined) {
    let found: Electron.NativeImage | null = null;
    for (const candidate of iconCandidatePaths('unreadOverlay.png')) {
      try {
        if (!fs.existsSync(candidate)) {
          continue;
        }
        const image = nativeImage.createFromPath(candidate);
        if (!image.isEmpty()) {
          found = image;
          break;
        }
      } catch {
        // try next candidate
      }
    }
    overlayIconCache = found;
  }
  return overlayIconCache ?? undefined;
}

/**
 * Apply a validated, clamped unread count to the correct native affordance for
 * the current platform. Exported for tests.
 *   win32  -> taskbar overlay icon on the main window (red dot + count in the
 *             description); clears the overlay at 0; no-ops if no window exists.
 *   other  -> `app.setBadgeCount` (macOS dock / Linux Unity launcher count).
 */
export function applyBadgeCount(count: number): void {
  if (process.platform === 'win32') {
    const win = getMainWindow();
    if (!win) {
      return; // no window yet — nothing to overlay; safe no-op
    }
    if (count > 0) {
      const text = formatBadgeText(count);
      const image = resolveOverlayIcon();
      // Skip only when the asset is missing; the description still carries the
      // count for assistive tech and hover.
      if (image) {
        win.setOverlayIcon(image, `${text} unread`);
      }
    } else {
      win.setOverlayIcon(null, ''); // clear the overlay
    }
    return;
  }
  app.setBadgeCount(count);
}

/**
 * Wire the one-way `set-badge-count` IPC. Treats the channel as an untrusted
 * boundary: the payload is validated + clamped before it drives any native
 * badge; a malformed payload is silently ignored.
 */
export function registerDockBadge(): void {
  ipcMain.on(SET_BADGE_COUNT_CHANNEL, (event, raw: unknown) => {
    // Every other IPC handler verifies the sender is our own window; this one didn't.
    // The value of that invariant is that it holds WITHOUT exception — a reader should
    // never have to work out why one channel is different.
    const win = getMainWindow();
    if (!win || event.sender !== win.webContents) {
      return;
    }
    const count = coerceBadgeCount(raw);
    if (count === null) {
      return; // malformed — leave the current badge as-is
    }
    applyBadgeCount(count);
  });
}
