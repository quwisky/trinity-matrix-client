import assert from 'node:assert/strict';
import type { DevtoolsEventConnection } from '../support/devtools-connection.mts';

export interface RoomWidgetFixtureOptions {
  readonly capabilityDelayMs?: number;
  readonly holdCapabilities?: boolean;
}

export interface RoomWidgetFixture {
  readonly requestCount: number;
  readonly referrers: readonly (string | undefined)[];
  close(): Promise<void>;
}

interface PausedRequest {
  readonly requestId: string;
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
}

function pausedRequest(value: unknown): PausedRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as {
    readonly requestId?: unknown;
    readonly request?: unknown;
  };
  if (
    typeof record.requestId !== 'string' ||
    !record.request ||
    typeof record.request !== 'object'
  ) {
    return undefined;
  }
  const request = record.request as {
    readonly method?: unknown;
    readonly url?: unknown;
    readonly headers?: unknown;
  };
  if (typeof request.method !== 'string' || typeof request.url !== 'string') {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return undefined;
  }
  const headers: Record<string, string> = {};
  if (request.headers && typeof request.headers === 'object') {
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers[name] = value;
    }
  }
  return {
    requestId: record.requestId,
    method: request.method,
    url,
    headers,
  };
}

function header(
  headers: Readonly<Record<string, string>>,
  expectedName: string,
): string | undefined {
  const match = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === expectedName.toLowerCase(),
  );
  return match?.[1];
}

function encodedHtml(body: string): string {
  return Buffer.from(body).toString('base64');
}

function widgetHtml(
  capabilityDelayMs: number,
  holdCapabilities: boolean,
): string {
  return `<!doctype html>
<html>
  <body>
    <h1>Widget fixture loaded</h1>
    <p id="requested"></p>
    <p id="approved"></p>
    <p id="policy-api"></p>
    <p id="denied"></p>
    <p id="request"></p>
    <script>
      const requested = ['m.always_on_screen', 'org.matrix.msc2762.timeline:*'];
      const policy = document.featurePolicy;
      document.querySelector('#policy-api').textContent =
        policy ? 'available' : 'missing';
      document.querySelector('#denied').textContent = JSON.stringify(
        ['camera', 'microphone', 'geolocation', 'display-capture',
         'clipboard-read', 'fullscreen'].map((feature) => [
          feature,
          policy ? policy.allowsFeature(feature) : false,
        ]),
      );
      const pendingCapabilityReplies = [];
      const releaseControl = document.createElement('meta');
      releaseControl.id = 'trinity-widget-capability-release';
      document.head.append(releaseControl);
      new MutationObserver(() => {
        if (releaseControl.dataset.release !== 'next') return;
        delete releaseControl.dataset.release;
        pendingCapabilityReplies.shift()?.();
      }).observe(releaseControl, { attributes: true });
      window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message || message.api !== 'toWidget' || !message.requestId) return;
        let response = {};
        if (message.action === 'capabilities') {
          document.querySelector('#request').textContent = JSON.stringify(message);
          document.querySelector('#requested').textContent = JSON.stringify(requested);
          response = { capabilities: requested };
        } else if (message.action === 'notify_capabilities') {
          document.querySelector('#approved').textContent =
            JSON.stringify(message.data.approved);
        } else if (message.action === 'supported_api_versions') {
          response = { supported_versions: [] };
        }
        const reply = () => parent.postMessage({ ...message, response }, event.origin);
        if (message.action === 'capabilities' && ${holdCapabilities}) {
          pendingCapabilityReplies.push(reply);
        } else if (message.action === 'capabilities') {
          setTimeout(reply, ${capabilityDelayMs});
        } else {
          reply();
        }
      });
    </script>
  </body>
</html>`;
}

const attackerHtml = '<!doctype html><title>Attacker frame</title>';
const changedOriginHtml = '<!doctype html><title>Changed origin</title>';

/** Serve the two source-owned widget peers without contacting public hosts. */
export async function installRoomWidgetFixture(
  connection: DevtoolsEventConnection,
  options: RoomWidgetFixtureOptions = {},
): Promise<RoomWidgetFixture> {
  const capabilityDelayMs = options.capabilityDelayMs ?? 0;
  const holdCapabilities = options.holdCapabilities ?? false;
  assert(
    Number.isInteger(capabilityDelayMs) && capabilityDelayMs >= 0,
    'Widget capability delay must be a nonnegative integer',
  );
  let requests = 0;
  const observedReferrers: (string | undefined)[] = [];
  let closed = false;
  let eventFailure: unknown;
  let work = Promise.resolve();

  const fulfill = async (requestId: string, body: string): Promise<void> => {
    await connection.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responsePhrase: 'OK',
      responseHeaders: [
        { name: 'Content-Type', value: 'text/html; charset=utf-8' },
        { name: 'Cache-Control', value: 'no-store' },
      ],
      body: encodedHtml(body),
    });
  };

  const handle = async (value: unknown): Promise<void> => {
    const paused = pausedRequest(value);
    if (!paused) throw new Error('Widget Fetch.requestPaused payload is malformed');
    if (
      paused.url.protocol === 'https:' &&
      paused.url.hostname === 'widgets.example'
    ) {
      if (paused.url.pathname === '/attacker') {
        await fulfill(paused.requestId, attackerHtml);
        return;
      }
      requests += 1;
      observedReferrers.push(header(paused.headers, 'referer'));
      await fulfill(
        paused.requestId,
        widgetHtml(capabilityDelayMs, holdCapabilities),
      );
      return;
    }
    if (
      paused.url.href === 'https://attacker.example/origin-change'
    ) {
      await fulfill(paused.requestId, changedOriginHtml);
      return;
    }
    await connection.send('Fetch.continueRequest', {
      requestId: paused.requestId,
    });
  };

  const unsubscribe = connection.on('Fetch.requestPaused', (params) => {
    if (closed) return;
    work = work.then(() => handle(params)).catch((error: unknown) => {
      eventFailure ??= error;
    });
  });

  try {
    await connection.send('Fetch.enable', {
      patterns: [
        {
          urlPattern: 'https://widgets.example/*',
          requestStage: 'Request',
        },
        {
          urlPattern: 'https://attacker.example/origin-change',
          requestStage: 'Request',
        },
      ],
    });
  } catch (error) {
    unsubscribe();
    throw error;
  }

  const throwIfFailed = (): void => {
    if (eventFailure !== undefined) throw eventFailure;
  };
  return {
    get requestCount() {
      throwIfFailed();
      return requests;
    },
    get referrers() {
      throwIfFailed();
      return [...observedReferrers];
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      unsubscribe();
      const failures: unknown[] = [];
      try {
        await work;
        throwIfFailed();
      } catch (error) {
        failures.push(error);
      }
      try {
        await connection.send('Fetch.disable');
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(failures, 'Room widget fixture cleanup failed');
      }
    },
  };
}
