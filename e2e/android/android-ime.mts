/**
 * Read-only Android IME visibility, filtered on the device.
 *
 * The full `dumpsys input_method` carries Gboard's own service state, about
 * 800 KB per call. Polling it through adb coincided with hosted emulators
 * dropping the adb transport, and every adb forward with it (run 36283529271).
 * The device-side grep returns the manager's single `mInputShown` line and
 * stops dumpsys before the keyboard app's section; `|| true` leaves a missing
 * field to {@link parseAndroidImeShown} instead of a bare grep exit status.
 * Stopping dumpsys early makes it report "Broken pipe" on stderr, which the
 * legacy `shell:` service that Playwright's Android backend uses merges into
 * stdout, so dumpsys's stderr is discarded on the device.
 */
export const ANDROID_IME_VISIBILITY_COMMAND =
  "dumpsys input_method 2>/dev/null | grep -m 1 -o 'mInputShown=[a-z]*' || true";

/** Parse {@link ANDROID_IME_VISIBILITY_COMMAND} output; a missing field throws. */
export function parseAndroidImeShown(output: string): boolean {
  const match = /^mInputShown=(true|false)$/u.exec(output.trim());
  if (!match) throw new Error('Android reports its IME visibility');
  return match[1] === 'true';
}
