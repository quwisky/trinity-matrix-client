import { describe, expect, it } from 'vitest';
import {
  KEYBOARD_SHOWN_COMMAND,
  SYSTEM_ERROR_DIALOGS_COMMAND,
  WEBVIEW_DEVTOOLS_UNFREEZE_COMMAND,
  parseKeyboardShown,
  parseSystemErrorDialogs,
  parseWebviewDevtoolsUnfreeze,
} from '../e2e/mobile/support/android-shell.mts';

describe('mobile E2E Android shell probes', () => {
  it('unfreezes every WebView DevTools socket owner sticky, then counts the frozen ones', () => {
    expect(WEBVIEW_DEVTOOLS_UNFREEZE_COMMAND).toContain(
      'grep -o "webview_devtools_remote_[0-9]*" /proc/net/unix',
    );
    expect(WEBVIEW_DEVTOOLS_UNFREEZE_COMMAND).toContain(
      'am unfreeze --sticky "$p"',
    );
    expect(WEBVIEW_DEVTOOLS_UNFREEZE_COMMAND).toContain(
      '/sys/fs/cgroup/apps/uid_*/pid_$p/cgroup.freeze',
    );
    expect(WEBVIEW_DEVTOOLS_UNFREEZE_COMMAND).toMatch(
      /echo "sockets=\$\(echo \$pids \| wc -w\) frozen=\$frozen"$/,
    );
  });

  it('parses the unfreeze summary and rejects anything else', () => {
    expect(parseWebviewDevtoolsUnfreeze('sockets=2 frozen=0\n')).toEqual({
      sockets: 2,
      frozen: 0,
    });
    expect(parseWebviewDevtoolsUnfreeze('sockets=3 frozen=1')).toEqual({
      sockets: 3,
      frozen: 1,
    });
    expect(() => parseWebviewDevtoolsUnfreeze('')).toThrow(/unfreeze summary/);
    expect(() =>
      parseWebviewDevtoolsUnfreeze('/system/bin/sh: am: not found'),
    ).toThrow(/am: not found/);
  });

  it('reads only the mInputShown lines, filtered on the device', () => {
    expect(KEYBOARD_SHOWN_COMMAND).toBe(
      'dumpsys input_method | grep mInputShown; true',
    );
  });

  it('parses mInputShown and rejects output without it', () => {
    expect(parseKeyboardShown('  mInputShown=true mShowRequested=true\n')).toBe(
      true,
    );
    expect(parseKeyboardShown('    mInputShown=false\n')).toBe(false);
    expect(() => parseKeyboardShown('')).toThrow(/mInputShown/);
  });

  it('lists system error dialog windows by title, filtered on the device', () => {
    expect(SYSTEM_ERROR_DIALOGS_COMMAND).toBe(
      'dumpsys window windows | grep -oE "Application (Not Responding|Error): [^ }]+" | sort -u; true',
    );
  });

  it('parses ANR and crash dialog titles and ignores everything else', () => {
    expect(
      parseSystemErrorDialogs(
        'Application Not Responding: com.google.android.apps.nexuslauncher\n' +
          'Application Error: com.android.systemui\r\n',
      ),
    ).toEqual([
      'Application Not Responding: com.google.android.apps.nexuslauncher',
      'Application Error: com.android.systemui',
    ]);
    expect(parseSystemErrorDialogs('')).toEqual([]);
    expect(
      parseSystemErrorDialogs('/system/bin/sh: dumpsys: inaccessible'),
    ).toEqual([]);
  });
});
