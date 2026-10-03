import { existsSync, readFileSync } from 'node:fs';
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
  parseWebViewVersion,
  webviewSwitchError,
} from './versions.mts';

export const APP_PACKAGE = 'eu.qwky.trinity';
const WEBVIEW_CONTEXT = `WEBVIEW_${APP_PACKAGE}`;

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
  await unfreezeWebviewOwners();
  await browser.switchContext('NATIVE_APP');
}

/** Soft keyboard visibility, read on the device without a context switch. */
export async function keyboardShown(): Promise<boolean> {
  return parseKeyboardShown(await shell(KEYBOARD_SHOWN_COMMAND));
}

/** Switch into the app's own WebView (never another app's) and apply the TLS bypass. */
export async function webview(): Promise<void> {
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
  await webview();
}

export async function restartApp(): Promise<void> {
  await native();
  await browser.terminateApp(APP_PACKAGE);
  await browser.activateApp(APP_PACKAGE);
  await webview();
}

export async function pressBack(): Promise<void> {
  await native();
  await browser.pressKeyCode(4);
  await webview();
}

export async function webviewVersion(): Promise<string> {
  return parseWebViewVersion(await shell('dumpsys', ['webviewupdate']));
}

/** The chromedriver Appium chose for this run, read from its server log. */
export function chromedriverVersion(): string {
  const log = appiumLogPath();
  return existsSync(log)
    ? chromedriverFromAppiumLog(readFileSync(log, 'utf8'))
    : 'unknown';
}
