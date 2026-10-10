import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { browser } from '@wdio/globals';
import {
  KEYBOARD_SHOWN_COMMAND,
  WEBVIEW_DEVTOOLS_UNFREEZE_COMMAND,
  parseKeyboardShown,
  parseWebviewDevtoolsUnfreeze,
} from './android-shell.mts';
import { appiumLogPath } from './artifacts.mts';
import {
  chromedriverFromAppiumLog,
  isAppNotYetKnown,
  parseWebViewVersion,
  webviewSwitchError,
} from './versions.mts';

const execFileAsync = promisify(execFile);

/** Android package and iOS bundle id: Capacitor uses `appId` for both. */
export const APP_PACKAGE = 'dev.trinityproject.trinity';
const WEBVIEW_CONTEXT = `WEBVIEW_${APP_PACKAGE}`;
/** WKWebView serves the bundled app from this origin. */
export const IOS_APP_ORIGIN = 'capacitor://localhost';

function requiredEnv(name: 'TRINITY_IOS_UDID' | 'TRINITY_IOS_APP'): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} is not set; run the iOS suite through run-ios.mts`,
    );
  return value;
}

/** `xcrun simctl` on the host; the wdio worker runs beside the Simulator. */
async function simctl(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('xcrun', ['simctl', ...args], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Every Appium context switch or lookup opens each WebView DevTools socket on the device.
 * Run this first so no frozen owner leaves those connections hanging.
 */
async function unfreezeWebviewOwners(): Promise<void> {
  const { sockets, frozen } = parseWebviewDevtoolsUnfreeze(
    await shell(WEBVIEW_DEVTOOLS_UNFREEZE_COMMAND),
  );
  if (frozen > 0) {
    throw new Error(
      `${frozen} of ${sockets} WebView DevTools socket owners stayed frozen after am unfreeze --sticky`,
    );
  }
}

export async function native(): Promise<void> {
  // The cached-app freezer is Android's; on iOS a context switch is all there is.
  if (!browser.isIOS) await unfreezeWebviewOwners();
  await browser.switchContext('NATIVE_APP');
}

/** Soft keyboard visibility, read without a context switch. */
export async function keyboardShown(): Promise<boolean> {
  if (browser.isIOS)
    return Boolean(await browser.execute('mobile: isKeyboardShown'));
  return parseKeyboardShown(await shell(KEYBOARD_SHOWN_COMMAND));
}

/**
 * WKWebView contexts are WEBVIEW_<pid>.<page>, and the first page can still be about:blank:
 * take the one that has loaded the bundled app. No certificate bypass exists here; the
 * runner trusts Caddy's root in the Simulator keychain instead.
 */
async function iosWebview(): Promise<void> {
  let seen: string[] = [];
  try {
    await browser.waitUntil(
      async () => {
        seen = (await browser.getContexts()).map(String);
        for (const context of seen.filter((name) =>
          name.startsWith('WEBVIEW_'),
        )) {
          await browser.switchContext(context);
          if ((await browser.getUrl()).startsWith(IOS_APP_ORIGIN)) return true;
        }
        return false;
      },
      { timeout: 60_000, interval: 1_000 },
    );
  } catch (error) {
    throw new Error(
      `no WKWebView context loaded ${IOS_APP_ORIGIN}; contexts: ${seen.join(', ') || 'none'}`,
      { cause: error },
    );
  }
}

/** Switch into the app's own WebView (never another app's) and apply the TLS bypass. */
export async function webview(): Promise<void> {
  if (browser.isIOS) return iosWebview();
  await browser.waitUntil(
    async () => {
      await unfreezeWebviewOwners();
      return (await browser.getContexts())
        .map(String)
        .includes(WEBVIEW_CONTEXT);
    },
    { timeout: 30_000, timeoutMsg: `${WEBVIEW_CONTEXT} never appeared` },
  );
  try {
    await browser.switchContext(WEBVIEW_CONTEXT);
  } catch (error) {
    throw webviewSwitchError(
      WEBVIEW_CONTEXT,
      {
        webview: await webviewVersion().catch(() => 'unknown'),
        chromedriver: chromedriverVersion(),
      },
      error,
    );
  }
  // acceptInsecureCerts covers chromedriver's own session; this covers the WebView target.
  await executeCdp('Security.setIgnoreCertificateErrors', { ignore: true });
}

/**
 * WebdriverIO binds its CDP commands only to Chromium sessions, so call Appium's
 * `goog/cdp/execute` route directly; in a WebView context Appium proxies it to chromedriver.
 */
async function executeCdp(
  cmd: string,
  params: Record<string, unknown>,
): Promise<void> {
  const { protocol, hostname, port, path = '/' } = browser.options;
  const url = new URL(
    `session/${browser.sessionId}/goog/cdp/execute`,
    `${protocol ?? 'http'}://${hostname}:${port}${path.endsWith('/') ? path : `${path}/`}`,
  );
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, params }),
  });
  if (!response.ok) {
    throw new Error(
      `${cmd} failed: ${response.status} ${await response.text()}`,
    );
  }
}

export async function shell(
  command: string,
  args: string[] = [],
): Promise<string> {
  return String(await browser.execute('mobile: shell', { command, args }));
}

export async function resetApp(): Promise<void> {
  await native();
  await browser.terminateApp(APP_PACKAGE);
  if (browser.isIOS) {
    // A reinstall is the Simulator's only route to an empty app container. The
    // notification prompt at first launch is accepted by appium:autoAcceptAlerts.
    const app = requiredEnv('TRINITY_IOS_APP');
    await browser.removeApp(APP_PACKAGE);
    await browser.installApp(app);
    try {
      await activateWhenKnown(15_000);
    } catch (error) {
      if (!isAppNotYetKnown(error)) throw error;
      // On a cold hosted runner FrontBoard once never registered a 1.4 s reinstall within
      // 15 s, while every other reinstall in the run launched within two attempts.
      // Installing again re-registers it.
      console.log(
        '[mobile] launch still not ready after 15 s; reinstalling once',
      );
      await browser.installApp(app);
      await activateWhenKnown(30_000);
    }
  } else {
    const cleared = await shell('pm', ['clear', APP_PACKAGE]);
    if (!cleared.includes('Success'))
      throw new Error(`pm clear failed: ${cleared}`);
    // Push registration asks for Android 13+ notifications after login. Grant up front, as the
    // Playwright layer did, so an OS-owned prompt cannot take focus or the first Back press.
    const granted = await shell('pm', [
      'grant',
      APP_PACKAGE,
      'android.permission.POST_NOTIFICATIONS',
    ]);
    if (granted.trim())
      throw new Error(`pm grant POST_NOTIFICATIONS failed: ${granted}`);
    await browser.activateApp(APP_PACKAGE);
  }
  await webview();
}

/** FrontBoard lags a fresh install by a moment: retry its NotFound or RequestDenied for `ms`. */
async function activateWhenKnown(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      await browser.activateApp(APP_PACKAGE);
      return;
    } catch (error) {
      if (!isAppNotYetKnown(error) || Date.now() > deadline) throw error;
      console.log(
        `[mobile] launch not ready yet, retrying: ${String(error).split('\n')[0].slice(0, 160)}`,
      );
      await browser.pause(500);
    }
  }
}

export async function restartApp(): Promise<void> {
  await native();
  await browser.terminateApp(APP_PACKAGE);
  await browser.activateApp(APP_PACKAGE);
  await webview();
}

/**
 * Android's system Back. iOS has no equivalent for an open dialog, sheet or panel: WebKit's
 * edge swipe is off while one is active (see the gesture policy in
 * trinity-application-session.adapter), so iOS specs use their in-app controls there. On a
 * routed page the swipe is history Back; {@link historyGestures} shows it switched on.
 */
export async function goBack(): Promise<void> {
  await native();
  await browser.pressKeyCode(4);
  await webview();
}

/**
 * Record what the app asks MainViewController to do with WebKit's history swipe, by
 * watching the `NativeNavigation.setGesturesEnabled` calls crossing the Capacitor bridge.
 * Read them back with {@link historyGestures}; a reload clears the record.
 */
export async function recordHistoryGestures(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as {
      __trnHistoryGestures?: boolean[];
      Capacitor: { toNative: (...args: unknown[]) => unknown };
    };
    if (w.__trnHistoryGestures) return;
    w.__trnHistoryGestures = [];
    const toNative = w.Capacitor.toNative;
    w.Capacitor.toNative = (...args: unknown[]) => {
      const [plugin, method, options] = args as [
        string,
        string,
        { enabled?: unknown },
      ];
      if (plugin === 'NativeNavigation' && method === 'setGesturesEnabled')
        w.__trnHistoryGestures?.push(options?.enabled === true);
      return toNative.apply(w.Capacitor, args);
    };
  });
}

/** Every history-swipe switch since {@link recordHistoryGestures}, oldest first. */
export async function historyGestures(): Promise<boolean[]> {
  return browser.execute(
    () =>
      (window as unknown as { __trnHistoryGestures?: boolean[] })
        .__trnHistoryGestures ?? [],
  );
}

export async function webviewVersion(): Promise<string> {
  if (browser.isIOS) {
    // WKWebView ships with the OS: the Simulator runtime is its version.
    const platformVersion = (browser.capabilities as Record<string, unknown>)[
      'platformVersion'
    ];
    return `iOS ${typeof platformVersion === 'string' ? platformVersion : 'unknown'}`;
  }
  return parseWebViewVersion(await shell('dumpsys', ['webviewupdate']));
}

/** The app's Preferences plist (Capacitor Preferences → UserDefaults) as XML text. */
export async function iosPreferences(): Promise<string> {
  const container = await simctl(
    'get_app_container',
    requiredEnv('TRINITY_IOS_UDID'),
    APP_PACKAGE,
    'data',
  );
  const { stdout } = await execFileAsync('plutil', [
    '-convert',
    'xml1',
    '-o',
    '-',
    join(container, 'Library/Preferences', `${APP_PACKAGE}.plist`),
  ]);
  return stdout;
}

/** The chromedriver Appium chose for this run, read from its server log. */
export function chromedriverVersion(): string {
  const log = appiumLogPath();
  return existsSync(log)
    ? chromedriverFromAppiumLog(readFileSync(log, 'utf8'))
    : 'unknown';
}
