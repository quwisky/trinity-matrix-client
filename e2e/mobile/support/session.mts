import { browser } from '@wdio/globals';

export const APP_PACKAGE = 'eu.qwky.trinity';
const WEBVIEW_CONTEXT = `WEBVIEW_${APP_PACKAGE}`;

export async function native(): Promise<void> {
  await browser.switchContext('NATIVE_APP');
}

/** Switch into the app's own WebView (never another app's) and apply the TLS bypass. */
export async function webview(): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await browser.getContexts()).map(String).includes(WEBVIEW_CONTEXT),
    { timeout: 30_000, timeoutMsg: `${WEBVIEW_CONTEXT} never appeared` },
  );
  await browser.switchContext(WEBVIEW_CONTEXT);
  // acceptInsecureCerts covers chromedriver's own session; this covers the WebView target.
  await executeCdp('Security.setIgnoreCertificateErrors', { ignore: true });
}

/**
 * WebdriverIO binds its CDP commands only to Chromium sessions, so call Appium's
 * `:vendor/cdp/execute` route directly; in a WebView context Appium proxies it to chromedriver.
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

async function shell(command: string, args: string[] = []): Promise<string> {
  return String(await browser.execute('mobile: shell', { command, args }));
}

export async function resetApp(): Promise<void> {
  await native();
  await browser.terminateApp(APP_PACKAGE);
  const cleared = await shell('pm', ['clear', APP_PACKAGE]);
  if (!cleared.includes('Success'))
    throw new Error(`pm clear failed: ${cleared}`);
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
  const out = await shell('dumpsys', ['webviewupdate']);
  return (
    /Current WebView package \(name, version\): \(([^)]+)\)/.exec(out)?.[1] ??
    out.slice(0, 200)
  );
}
