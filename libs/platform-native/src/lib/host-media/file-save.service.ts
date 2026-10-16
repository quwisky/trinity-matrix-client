import { Injectable } from '@angular/core';
import { Observable, defer, from } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/** `cancelled` when the user dismissed the native share sheet; the web path can't tell. */
export type FileSaveResult = 'saved' | 'cancelled';

/**
 * Host adapter that saves a downloaded attachment blob: natively it writes the bytes to the
 * cache and opens the OS share sheet; on the web it triggers an `<a download>` download.
 */
@Injectable({ providedIn: 'root' })
export class FileSaveService {
  /** Whether the host supports a direct browser-style download affordance. */
  readonly directDownloadAvailable = !Capacitor.isNativePlatform();

  /** True when native save/share (Filesystem + Share) should be used. */
  readonly nativeAvailable =
    Capacitor.isNativePlatform() &&
    Capacitor.isPluginAvailable('Filesystem') &&
    Capacitor.isPluginAvailable('Share');

  /** Save (native: write + share sheet; web: download link) a blob under its name. */
  save(blob: Blob, filename: string): Observable<FileSaveResult> {
    return defer(() =>
      from(
        this.nativeAvailable
          ? this.saveNative(blob, filename)
          : this.saveWeb(blob, filename),
      ),
    );
  }

  /** Write the blob to the cache and surface the native share sheet. */
  private async saveNative(
    blob: Blob,
    filename: string,
  ): Promise<FileSaveResult> {
    const data = await blobToBase64(blob);
    // The receiving app reads a content:// URI asynchronously; on Android share() resolves
    // before that finishes, so deleting now can truncate the share (same on iOS). Each share
    // gets its own cache subfolder (so the target sees a clean filename) and earlier shares
    // are swept first: by the next save the earlier receiver has long finished reading, so
    // plaintext never lingers and the delete can't race it.
    await sweepShareDir();
    const path = `${SHARE_DIR}/${uniqueToken()}/${safeName(filename)}`;
    const { uri } = await Filesystem.writeFile({
      path,
      data,
      directory: Directory.Cache,
      recursive: true,
    });
    try {
      await Share.share({ files: [uri], dialogTitle: 'Save or share' });
      return 'saved';
    } catch (err) {
      // Dismissing the share sheet rejects: a user choice, neither a save nor a failure.
      if (isShareCancel(err)) {
        return 'cancelled';
      }
      throw err;
    }
  }

  /** Browser download via a transient object URL on an `<a download>`. */
  private async saveWeb(blob: Blob, filename: string): Promise<FileSaveResult> {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return 'saved';
  }
}

/** Cache subfolder holding files handed to the OS share sheet (swept per save). */
const SHARE_DIR = 'trinity-shared';

/**
 * Delete the cache subfolder of all previous shares (best-effort), so a former share's
 * plaintext never lingers without deleting a file the current receiver may still be reading.
 */
async function sweepShareDir(): Promise<void> {
  await Filesystem.rmdir({
    path: SHARE_DIR,
    directory: Directory.Cache,
    recursive: true,
  }).catch(() => undefined); // missing dir on the first share — nothing to sweep
}

/** A random, collision-free folder name so concurrent/sequential shares never clash. */
function uniqueToken(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) {
    return c.randomUUID();
  }
  const bytes = new Uint8Array(16);
  c?.getRandomValues?.(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Read a blob as an unprefixed base64 string (what Filesystem.writeFile expects). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // onload is success-only; onloadend also fires on error, where reader.result is null.
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(reader.error ?? new Error('Could not read file'));
        return;
      }
      // Filesystem wants raw base64, without the `data:<mime>;base64,` prefix.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error('Could not read file'));
    reader.readAsDataURL(blob);
  });
}

/** Max filename length kept well under the common 255-byte filesystem limit. */
const MAX_NAME_LENGTH = 200;

/** Reduce a (sender-controlled, possibly path-bearing/empty) filename to a safe basename. */
function safeName(filename: string): string {
  let base = filename.replace(/[/\\]/g, '_').trim();
  // A bare "." / ".." would resolve to the cache dir (or its parent) and fail.
  if (!base || base === '.' || base === '..') {
    base = 'download';
  }
  if (base.length <= MAX_NAME_LENGTH) {
    return base;
  }
  // Truncate, preserving a short extension when present.
  const dot = base.lastIndexOf('.');
  if (dot > 0 && base.length - dot <= 16) {
    const ext = base.slice(dot);
    return base.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  return base.slice(0, MAX_NAME_LENGTH);
}

/**
 * The code-less rejection @capacitor/share 8 gives a dismissed sheet: iOS when
 * `UIActivityViewController` completes with `completed == false`, Android when the chooser
 * returns `RESULT_CANCELED` while Trinity's activity never stopped.
 *
 * Re-check this exact match whenever @capacitor/share is upgraded (8.0.3: `SharePlugin.swift:63`,
 * `SharePlugin.java:79`); if the message changes, a dismissal becomes a reported failure.
 */
const SHARE_CANCELED = 'Share canceled';

/** Whether a Share rejection is the user dismissing the sheet (not an error). */
function isShareCancel(err: unknown): boolean {
  return err instanceof Error && err.message === SHARE_CANCELED;
}
