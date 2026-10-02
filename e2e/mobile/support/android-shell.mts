/** Device-side shell probes the mobile suite runs through `mobile: shell`, and their parsers. */

/**
 * UiAutomator2 lists contexts by opening every `webview_devtools_remote_<pid>` socket in
 * /proc/net/unix. Android's cached-app freezer freezes background WebView processes (the
 * Google app, or Trinity behind another app); a frozen owner keeps a socket that accepts but
 * never answers. On hosted emulators, the adb transport dropped right after such CDP
 * timeouts. Unfreeze every owner sticky, so a running one is not frozen again, and report
 * how many stayed frozen.
 */
export const WEBVIEW_DEVTOOLS_UNFREEZE_COMMAND =
  'pids=$(grep -o "webview_devtools_remote_[0-9]*" /proc/net/unix | sed "s/.*_//" | sort -u); ' +
  'for p in $pids; do am unfreeze --sticky "$p" >/dev/null 2>&1; done; frozen=0; ' +
  'for p in $pids; do case "$(cat /sys/fs/cgroup/apps/uid_*/pid_$p/cgroup.freeze 2>/dev/null)" in 1) frozen=$((frozen+1));; esac; done; ' +
  'echo "sockets=$(echo $pids | wc -w) frozen=$frozen"';

export function parseWebviewDevtoolsUnfreeze(output: string): {
  readonly sockets: number;
  readonly frozen: number;
} {
  const match = /^sockets=(\d+) frozen=(\d+)$/u.exec(output.trim());
  if (!match) {
    throw new Error(
      `Unreadable WebView DevTools unfreeze summary: ${JSON.stringify(output)}`,
    );
  }
  return { sockets: Number(match[1]), frozen: Number(match[2]) };
}

/**
 * The full `dumpsys input_method` (what Appium's isKeyboardShown reads) is ~800 KB of
 * Gboard state; polling it through adb coincided with hosted emulators dropping the adb
 * transport. Filter the line Appium parses on the device instead.
 */
export const KEYBOARD_SHOWN_COMMAND =
  'dumpsys input_method | grep mInputShown; true';

export function parseKeyboardShown(output: string): boolean {
  const match = /mInputShown=(true|false)\b/u.exec(output);
  if (!match) {
    throw new Error(
      `dumpsys input_method reported no mInputShown: ${JSON.stringify(output)}`,
    );
  }
  return match[1] === 'true';
}
