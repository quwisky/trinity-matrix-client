import { Injectable } from '@angular/core';
import { Observable, defer, from } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/**
 * Saves a downloaded attachment blob to the device. On a native platform it
 * writes the bytes to the cache and opens the OS share sheet (so the user can
 * save to Files/Photos or send it on); on the web it triggers a browser download
 * via an `<a download>` link. Centralizes the platform branch so the timeline's
 * media UI never feature-detects inline.
 */
@Injectable({ providedIn: 'root' })
export class FileSaveService {
  /** True when native save/share (Filesystem + Share) should be used. */
  readonly nativeAvailable =
    Capacitor.isNativePlatform() &&
    Capacitor.isPluginAvailable('Filesystem') &&
    Capacitor.isPluginAvailable('Share');

  /** Save (native: write + share sheet; web: download link) a blob under its name. */
  save(blob: Blob, filename: string): Observable<void> {
    return defer(() =>
      from(
        this.nativeAvailable
          ? this.saveNative(blob, filename)
          : this.saveWeb(blob, filename),
      ),
    );
  }

  /** Write the blob to the cache and surface the native share sheet. */
  private async saveNative(blob: Blob, filename: string): Promise<void> {
    const data = await blobToBase64(blob);
    const path = safeName(filename);
    const { uri } = await Filesystem.writeFile({
      path,
      data,
      directory: Directory.Cache,
    });
    try {
      await Share.share({ files: [uri], dialogTitle: 'Save or share' });
    } catch (err) {
      // Dismissing the share sheet rejects — that's a user choice, not a failure.
      if (!isShareCancel(err)) {
        throw err;
      }
    } finally {
      // Don't leave the decrypted plaintext in the cache after the sheet closes
      // (the share target has already copied it by the time share() resolves).
      await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(
        () => undefined,
      );
    }
  }

  /** Browser download via a transient object URL on an `<a download>`. */
  private async saveWeb(blob: Blob, filename: string): Promise<void> {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}

/** Read a blob as an unprefixed base64 string (what Filesystem.writeFile expects). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // onload is success-only; onerror owns every failure path. (onloadend fires on
    // both, and on an error reader.result is null — slicing it would throw.)
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(reader.error ?? new Error('Could not read file'));
        return;
      }
      // Strip the `data:<mime>;base64,` prefix; Filesystem wants raw base64.
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

/** Whether a Share rejection is the user dismissing the sheet (not an error). */
function isShareCancel(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /cancel|abort|dismiss/i.test(message);
}
