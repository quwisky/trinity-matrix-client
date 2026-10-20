import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { browser } from '@wdio/globals';
import {
  CLOSE_SYSTEM_DIALOGS_COMMAND,
  KEYBOARD_SHOWN_COMMAND,
  SYSTEM_ERROR_DIALOGS_COMMAND,
  WEBVIEW_DEVTOOLS_UNFREEZE_COMMAND,
  parseKeyboardShown,
  parseSystemErrorDialogs,
  parseWebviewDevtoolsUnfreeze,
} from './android-shell.mts';
import {
  pickAppWebview,
  type AppiumContext,
} from '../../support/appium-contexts.mts';
import { describeAppiumFailure } from '../../support/http-failure.mts';
import { appiumLogPath } from './artifacts.mts';
import {
  chromedriverFromAppiumLog,
  frontBoardReason,
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
 * take the one that has loaded the bundled app. It is chosen from Appium's details (its URL
 * and owning bundle) without switching into any page: once a spec has opened Safari, its pages
 * are WEBVIEW_ contexts too, and switching into one can hang the session (#1347). See
 * `pickAppWebview`. No certificate bypass exists here; the
 * runner trusts Caddy's root in the Simulator keychain instead.
 */
async function iosWebview(): Promise<void> {
  let seen: AppiumContext[] = [];
  try {
    await browser.waitUntil(
      async () => {
        seen = (await browser.getContexts({
          returnDetailedContexts: true,
        })) as AppiumContext[];
        const own = pickAppWebview(seen, {
          origin: IOS_APP_ORIGIN,
          bundleId: APP_PACKAGE,
        });
        if (!own) return false;
        await browser.switchContext(own.id);
        return true;
      },
      { timeout: 60_000, interval: 1_000 },
    );
  } catch (error) {
    const contexts = seen
      .map(({ id, url, bundleId }) =>
        [id, bundleId, url].filter(Boolean).join(' '),
      )
      .join(', ');
    throw new Error(
      `no WKWebView context loaded ${IOS_APP_ORIGIN}; contexts: ${contexts || 'none'}`,
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
    throw new Error(await describeAppiumFailure(cmd, response));
  }
}

export async function shell(
  command: string,
  args: string[] = [],
): Promise<string> {
  return String(await browser.execute('mobile: shell', { command, args }));
}

/**
 * Close any system error dialog left open (see SYSTEM_ERROR_DIALOGS_COMMAND), so the spec
 * starts with input focus available to the app. The runner stops new ones from showing; this
 * clears one raised before that, and names it in the run log.
 */
async function closeSystemErrorDialogs(): Promise<void> {
  const openDialogs = async (): Promise<string[]> =>
    parseSystemErrorDialogs(await shell(SYSTEM_ERROR_DIALOGS_COMMAND));
  const open = await openDialogs();
  if (open.length === 0) return;
  console.log(`[mobile] closing system error dialogs: ${open.join('; ')}`);
  await shell(CLOSE_SYSTEM_DIALOGS_COMMAND);
  await browser.waitUntil(async () => (await openDialogs()).length === 0, {
    timeout: 10_000,
    interval: 500,
    timeoutMsg: `system error dialogs stayed open: ${open.join('; ')}`,
  });
}

export async function resetApp(): Promise<void> {
  await native();
  if (!browser.isIOS) await closeSystemErrorDialogs();
  await browser.terminateApp(APP_PACKAGE);
  if (browser.isIOS) {
    // A reinstall is the Simulator's only route to an empty app container. The
    // notification prompt at first launch is accepted by appium:autoAcceptAlerts.
    const app = requiredEnv('TRINITY_IOS_APP');
    await browser.removeApp(APP_PACKAGE);
    await browser.installApp(app);
    await launchAfterInstall(app);
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

/**
 * Every refused launch after a reinstall in nightlies 38877693663, 39113082294 and 39233620715
 * was RequestDenied > NotFound: SpringBoard had not registered the new install yet. Either it
 * did within 8.5 s, or it never did: 15 s of retries changed nothing there, and installing
 * again registered the app at once. So retry briefly, then install again.
 */
const REINSTALL_AFTER_MS = 10_000;
const LAUNCH_DEADLINE_MS = 40_000;

async function launchAfterInstall(app: string): Promise<void> {
  const started = Date.now();
  let attempts = 0;
  let reinstalled = false;
  let delay = 250;
  for (;;) {
    attempts += 1;
    try {
      await browser.activateApp(APP_PACKAGE);
      break;
    } catch (error) {
      const elapsed = Date.now() - started;
      if (!isAppNotYetKnown(error) || elapsed > LAUNCH_DEADLINE_MS) throw error;
      console.log(
        `[mobile] launch not ready yet (attempt ${attempts}, ${seconds(elapsed)} after install), retrying: ${frontBoardReason(error)}`,
      );
      if (!reinstalled && elapsed >= REINSTALL_AFTER_MS) {
        console.log(
          '[mobile] FrontBoard still does not know the app; installing it again',
        );
        await browser.installApp(app);
        reinstalled = true;
        delay = 250;
        continue;
      }
      await browser.pause(delay);
      delay = Math.min(delay * 2, 1_000);
    }
  }
  if (attempts > 1)
    console.log(
      `[mobile] launched after ${attempts} attempts in ${seconds(Date.now() - started)}${reinstalled ? ', after a second install' : ''}`,
    );
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export async function restartApp(): Promise<void> {
  await native();
  await browser.terminateApp(APP_PACKAGE);
  await browser.activateApp(APP_PACKAGE);
  await webview();
}

/**
 * Android's system Back. iOS has no equivalent for an open dialog, sheet or panel: WebKit's
 * edge swipe is off while one is active (see the gesture policy in
 * trinity-host-navigation.adapter), so iOS specs use their in-app controls there. On a
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

/** The installed app's container for an app group it shares with its extensions. */
export async function iosAppGroupContainer(group: string): Promise<string> {
  return simctl(
    'get_app_container',
    requiredEnv('TRINITY_IOS_UDID'),
    APP_PACKAGE,
    group,
  );
}

/** The chromedriver Appium chose for this run, read from its server log. */
export function chromedriverVersion(): string {
  const log = appiumLogPath();
  return existsSync(log)
    ? chromedriverFromAppiumLog(readFileSync(log, 'utf8'))
    : 'unknown';
}
