/**
 * Trigger a browser download of in-memory text through a data URL.
 *
 * A data URL rather than a blob URL because there is nothing to revoke afterwards and the
 * payloads here are small (an armored key file, a settings document). Web and desktop only:
 * native WebViews have no reliable download, so every caller gates on the platform first —
 * see `advanced-settings.component.ts` and the note at `recovery-key-display.component.ts`.
 */
export function downloadTextFile(
  doc: Document,
  file: {
    readonly name: string;
    readonly mimeType: string;
    readonly content: string;
  },
): void {
  const anchor = doc.createElement('a');
  anchor.href = `data:${file.mimeType};charset=utf-8,${encodeURIComponent(file.content)}`;
  anchor.download = file.name;
  anchor.click();
}
