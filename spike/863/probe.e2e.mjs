// Records what an XCUITest session can see of the app's WKWebView. Never asserts more
// than "a WebView context exists"; everything else is written to SPIKE_OUT for the report.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const phase = process.env.SPIKE_PHASE;
const record = (name, value) =>
  writeFileSync(
    join(process.env.SPIKE_OUT, `${phase}-${name}.json`),
    JSON.stringify(value, null, 2),
  );

describe(`iOS WKWebView probe (${phase})`, () => {
  it('reaches the WebView and the TLS homeserver', async () => {
    const started = Date.now();
    let contexts = [];
    while (Date.now() - started < 120_000) {
      contexts = await browser.getContexts({ returnDetailedContexts: true });
      if (contexts.some((c) => String(c.id ?? c).startsWith('WEBVIEW'))) break;
      await browser.pause(2_000);
    }
    record('contexts', { waitedMs: Date.now() - started, contexts });
    await browser.saveScreenshot(
      join(process.env.SPIKE_OUT, `${phase}-native.png`),
    );
    const webview = contexts.find((c) =>
      String(c.id ?? c).startsWith('WEBVIEW'),
    );
    if (!webview)
      throw new Error(`no WEBVIEW context: ${JSON.stringify(contexts)}`);
    await browser.switchContext(webview.id ?? webview);
    await browser.setTimeout({ script: 30_000 });
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => location.href)).startsWith('capacitor://'),
      { timeout: 60_000, timeoutMsg: 'app page never loaded' },
    );

    const page = await browser.execute(() => ({
      href: location.href,
      title: document.title,
      userAgent: navigator.userAgent,
      bodyLength: document.body.innerHTML.length,
      hasHomeserverField: [...document.querySelectorAll('label')].some((l) =>
        /homeserver/i.test(l.textContent ?? ''),
      ),
    }));
    record('page', page);

    const probe = (url) =>
      browser
        .execute(async (target) => {
          try {
            const r = await fetch(target);
            return {
              ok: r.ok,
              status: r.status,
              body: (await r.text()).slice(0, 120),
            };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        }, url)
        .catch((e) => ({ ok: false, driverError: String(e).slice(0, 300) }));
    record(
      'tls',
      await probe('https://localhost:8448/_matrix/client/versions'),
    );
    record(
      'plain-http',
      await probe('http://localhost:8008/_matrix/client/versions'),
    );
  });
});
