import type { Page } from '@playwright/test';

export interface WidgetFixtureProbe {
  readonly requestCount: () => number;
  readonly referrers: () => readonly (string | undefined)[];
}

/** Serve a cross-origin Widget API peer without contacting the public internet. */
export async function installWidgetFixture(
  page: Page,
  capabilityDelayMs = 0,
): Promise<WidgetFixtureProbe> {
  let requests = 0;
  const referrers: (string | undefined)[] = [];
  await page.route('https://widgets.example/**', async (route) => {
    requests += 1;
    referrers.push(route.request().headers()['referer']);
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: widgetHtml(capabilityDelayMs),
    });
  });
  return {
    requestCount: () => requests,
    referrers: () => referrers,
  };
}

function widgetHtml(capabilityDelayMs: number): string {
  return `<!doctype html>
<html>
  <body>
    <h1>Widget fixture loaded</h1>
    <p id="requested"></p>
    <p id="approved"></p>
    <p id="denied"></p>
    <script>
      const requested = ['m.always_on_screen', 'org.matrix.msc2762.timeline:*'];
      const policy = document.featurePolicy;
      document.querySelector('#denied').textContent = JSON.stringify(
        ['camera', 'microphone', 'geolocation', 'display-capture',
         'clipboard-read', 'fullscreen'].map((feature) => [
          feature,
          policy ? policy.allowsFeature(feature) : false,
        ]),
      );
      window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message || message.api !== 'toWidget' || !message.requestId) return;
        let response = {};
        if (message.action === 'capabilities') {
          document.querySelector('#requested').textContent = JSON.stringify(requested);
          response = { capabilities: requested };
        } else if (message.action === 'notify_capabilities') {
          document.querySelector('#approved').textContent =
            JSON.stringify(message.data.approved);
        } else if (message.action === 'supported_api_versions') {
          response = { supported_versions: [] };
        }
        const reply = () => parent.postMessage({ ...message, response }, event.origin);
        if (message.action === 'capabilities') {
          setTimeout(reply, ${capabilityDelayMs});
        } else {
          reply();
        }
      });
    </script>
  </body>
</html>`;
}
