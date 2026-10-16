import { app, ipcMain, nativeImage } from 'electron';
import * as fs from 'node:fs';
import { iconCandidatePaths } from './icons';
import { getMainWindow } from './window';

// Dock / launcher / taskbar unread badge. SET_BADGE_COUNT_CHANNEL pushes the app-wide unread
// total from the renderer; the payload is untrusted and validated and clamped
// (coerceBadgeCount) before it drives any native badge.
//
// Platform split (see applyBadgeCount): macOS / Linux(Unity) `app.setBadgeCount` draws the
// numeric count, and 0 clears it. Windows has no numeric taskbar badge, so a red "unread
// present" overlay icon (BrowserWindow.setOverlayIcon) shows for count > 0 and clears at 0;
// the count rides in the overlay's accessibility description ("5 unread" / "99+ unread").
export const SET_BADGE_COUNT_CHANNEL = 'trinity:host:v1:badge:set';

/** Upper bound for the displayed badge; larger totals are clamped to it. */
export const MAX_BADGE_COUNT = 9999;

// Lazily resolved overlay image: `undefined` not yet resolved, `null` none found (no overlay).
let overlayIconCache: Electron.NativeImage | null | undefined;

/**
 * Validate and clamp an untrusted badge count: a finite number, floored and clamped to
 * `[0, MAX_BADGE_COUNT]`. Returns `null` for anything malformed (non-number, `NaN`,
 * `Infinity`) so the caller leaves the current badge untouched.
 */
function coerceBadgeCount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null;
  }
  return Math.min(Math.max(Math.floor(raw), 0), MAX_BADGE_COUNT);
}

/** Overlay description text; a taskbar overlay conveys ~3 characters, so past 99 it is `99+`. */
function formatBadgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * Red-dot overlay image for the Windows taskbar, resolved once and cached. A bundled PNG,
 * not a generated numbered badge: `nativeImage.createFromDataURL` decodes PNG/JPEG only (an
 * `image/svg+xml` data URL yields an empty image) and the main process has no canvas or
 * font rasterizer. Returns `undefined` when the asset is missing, so we skip drawing
 * rather than pass a blank image.
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

/** Apply a validated, clamped count: the taskbar overlay on win32, else `app.setBadgeCount`. */
function applyBadgeCount(count: number): void {
  if (process.platform === 'win32') {
    const win = getMainWindow();
    if (!win) {
      return; // no window yet, nothing to overlay
    }
    if (count > 0) {
      const text = formatBadgeText(count);
      const image = resolveOverlayIcon();
      // Skip only when the asset is missing.
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
 * Wire the versioned badge-operation IPC. An untrusted boundary: sender and payload are
 * validated before native state changes, and every request gets an explicit secret-safe
 * outcome.
 */
export function registerDockBadge(): void {
  ipcMain.handle(SET_BADGE_COUNT_CHANNEL, (event, raw: unknown) => {
    // Verify the sender like every other IPC handler: the invariant holds without exception.
    const win = getMainWindow();
    if (!win || event.sender !== win.webContents) {
      return {
        kind: 'rejected',
        diagnostic: { code: 'sender-rejected' },
      } as const;
    }
    const count = coerceBadgeCount(raw);
    if (count === null) {
      return {
        kind: 'rejected',
        diagnostic: { code: 'invalid-badge-count' },
      } as const;
    }
    try {
      applyBadgeCount(count);
      return { kind: 'completed' } as const;
    } catch {
      return {
        kind: 'rejected',
        diagnostic: { code: 'badge-host-failed' },
      } as const;
    }
  });
}
