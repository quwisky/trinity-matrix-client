/** Device-side shell probes the mobile suite runs through `mobile: shell`, and their parsers. */

/**
 * Add a CA pushed to /data/local/tmp to the system store of every app started from now on, as
 * root. Android 14+ reads it from the Conscrypt APEX, read-only and per mount namespace, so a
 * tmpfs copy is bind-mounted over it in the zygotes' namespaces, which apps inherit. Until the
 * emulator reboots. No failure of a step passes: `set -e`, and the last `ls` checks the result.
 */
export function trustSystemCaCommand(certificateFile: string): string {
  const apex = '/apex/com.android.conscrypt/cacerts';
  const copy = '/system/etc/security/cacerts';
  const saved = '/data/local/tmp/trinity-cacerts';
  return [
    'set -e',
    `mkdir -p -m 700 ${saved}`,
    `cp ${apex}/* ${saved}/`,
    `mount -t tmpfs tmpfs ${copy}`,
    `cp ${saved}/* /data/local/tmp/${certificateFile} ${copy}/`,
    `rm -rf ${saved}`,
    `chown root:root ${copy} ${copy}/*`,
    `chmod 755 ${copy}`,
    `chmod 644 ${copy}/*`,
    `chcon u:object_r:system_file:s0 ${copy} ${copy}/*`,
    'pids=$(pidof zygote zygote64)',
    `for pid in $pids; do nsenter --mount=/proc/$pid/ns/mnt -- /system/bin/mount --bind ${copy} ${apex}; done`,
    `for pid in $pids; do nsenter --mount=/proc/$pid/ns/mnt -- /system/bin/ls ${apex}/${certificateFile}; done`,
  ].join('; ');
}

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

/**
 * The system server's error dialogs ("<app> isn't responding", "<app> keeps stopping") take
 * input focus over every app. On cold hosted emulators Pixel Launcher sometimes missed its
 * NotificationListener service timeout while the boot settled, and its ANR dialog kept focus
 * for the rest of the run: Back, the IME, permission prompts, the photo picker, the share
 * chooser and Custom Tabs never reached the app. AppNotRespondingDialog and AppErrorDialog
 * title their windows this way; list the open ones.
 */
export const SYSTEM_ERROR_DIALOGS_COMMAND =
  'dumpsys window windows | grep -oE "Application (Not Responding|Error): [^ }]+" | sort -u; true';

const SYSTEM_ERROR_DIALOG = /^Application (?:Not Responding|Error): \S+$/u;

export function parseSystemErrorDialogs(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => SYSTEM_ERROR_DIALOG.test(line));
}

/**
 * Every system error dialog closes itself on this broadcast; an ANR dialog closes its app,
 * as "Close app" would. The shell holds BROADCAST_CLOSE_SYSTEM_DIALOGS.
 */
export const CLOSE_SYSTEM_DIALOGS_COMMAND =
  'am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS';

/**
 * Global setting that stops the system server from showing error dialogs; it then closes an
 * unresponsive app instead. The activity task manager observes it, so it applies at once.
 */
export const HIDE_ERROR_DIALOGS_SETTING = 'hide_error_dialogs';

/** The focused window and app: who receives Back and the IME when a spec fails. */
export const WINDOW_FOCUS_COMMAND =
  'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"; true';

/**
 * How many windows carry FLAG_SECURE, which App lock's app-switcher cover sets on Trinity's
 * activity (blank recents preview, no screenshots or screen recording). Dumpsys lists a
 * window's flags as `fl=A B C`; the emulator shows no other secure window, so a count above
 * zero is Trinity's.
 */
export const SECURE_WINDOW_COMMAND =
  'dumpsys window windows | grep -cE "(fl=| )SECURE( |$)"; true';

export function parseSecureWindow(output: string): boolean {
  const count = output.trim();
  if (!/^\d+$/u.test(count)) {
    throw new Error(
      `Unreadable secure-window count: ${JSON.stringify(output)}`,
    );
  }
  return Number(count) > 0;
}
