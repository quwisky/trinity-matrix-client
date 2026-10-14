import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { type ElectronApplication } from 'playwright';
import { fillLabeledInput } from '../support/app.mts';
import { expect, test, type Page } from './fixtures.mts';
import { launchApp } from './support/launch.mts';

// The shell picks its channel from electron/package.json when unpackaged: Trinity Next
// on main (X.Y.Z-next.N), Trinity on a release branch. Mirrors CHANNEL_IDENTITY in
// electron/src/release-channel.ts; this journey proves the launched shell agrees.
const shellVersion = (
  JSON.parse(
    readFileSync(
      new URL('../../electron/package.json', import.meta.url),
      'utf8',
    ),
  ) as { version: string }
).version;
const expected = /^\d+\.\d+\.\d+-next\.\d+$/.test(shellVersion)
  ? {
      channel: 'next',
      productName: 'Trinity Next',
      deepLinkScheme: 'dev.trinityproject.trinity.next',
      displayName: 'Trinity Next',
    }
  : {
      channel: 'stable',
      productName: 'Trinity',
      deepLinkScheme: 'dev.trinityproject.trinity',
      displayName: 'Trinity',
    };

interface FakeHomeserver {
  readonly origin: string;
  /** Bodies of password sign-in requests, in order. */
  readonly logins: unknown[];
  close(): Promise<void>;
}

/** A homeserver that offers password and SSO sign-in and refuses every password. */
async function startFakeHomeserver(): Promise<FakeHomeserver> {
  const logins: unknown[] = [];
  const server = createServer(
    {
      key: readFileSync(
        new URL('./fixtures/localhost-key.pem', import.meta.url),
      ),
      cert: readFileSync(
        new URL('./fixtures/localhost-cert.pem', import.meta.url),
      ),
    },
    (request, response) => {
      const send = (status: number, body?: unknown) => {
        response.writeHead(status, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
          'Content-Type': 'application/json',
        });
        response.end(body === undefined ? '' : JSON.stringify(body));
      };
      const path = new URL(request.url ?? '/', 'https://localhost').pathname;
      if (request.method === 'OPTIONS') return send(204);
      if (request.method === 'GET' && path === '/_matrix/client/versions') {
        return send(200, { versions: ['v1.11'] });
      }
      if (request.method === 'GET' && path === '/_matrix/client/v3/login') {
        return send(200, {
          flows: [{ type: 'm.login.password' }, { type: 'm.login.sso' }],
        });
      }
      if (request.method === 'POST' && path === '/_matrix/client/v3/login') {
        let body = '';
        request.on('data', (chunk: Buffer) => (body += chunk.toString()));
        request.on('end', () => {
          logins.push(JSON.parse(body));
          send(403, { errcode: 'M_FORBIDDEN', error: 'Invalid password' });
        });
        return;
      }
      send(404, { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    logins,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

type OpenExternal = (url: string) => Promise<void>;
type CaptureGlobals = {
  trinityOpenedUrls?: string[];
  trinityRealOpenExternal?: OpenExternal;
};

let app: ElectronApplication;
let page: Page;
let homeserver: FakeHomeserver;

test.beforeAll(async () => {
  homeserver = await startFakeHomeserver();
  app = await launchApp();
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  await homeserver?.close();
});

/**
 * Reach the fake homeserver's sign-in methods from a fresh sign-in page, so each test
 * stands alone (Playwright restarts the worker after a failure).
 */
async function discoverFakeHomeserver(): Promise<void> {
  await page.reload();
  await fillLabeledInput(page, 'Homeserver', homeserver.origin);
  await page.getByText('Continue', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Sign in' })
    .waitFor({ timeout: 30_000 });
}

test('runs under its channel name and reports its identity to the renderer', async () => {
  expect(
    await app.evaluate(({ app: electronApp }) => electronApp.getName()),
  ).toBe(expected.productName);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as { trinityDesktop?: { appIdentity?: unknown } })
            .trinityDesktop?.appIdentity,
      ),
    )
    .toEqual({
      channel: expected.channel,
      deepLinkScheme: expected.deepLinkScheme,
      displayName: expected.displayName,
    });
});

test('signs in with a password as a device named after the app', async () => {
  await discoverFakeHomeserver();
  await fillLabeledInput(page, 'Username', 'channel-check');
  await fillLabeledInput(page, 'Password', 'not-a-real-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect.poll(() => homeserver.logins.length).toBe(1);
  expect(homeserver.logins[0]).toMatchObject({
    type: 'm.login.password',
    initial_device_display_name: expected.displayName,
  });
});

test("sends the SSO callback to this app's own scheme", async () => {
  await discoverFakeHomeserver();
  // Capture the system-browser hand-off instead of opening a browser. The window-open
  // handler's own https filter still runs; only the final OS call is replaced. Read the
  // stub back so a silently ignored assignment fails here instead of opening a browser.
  await app.evaluate(({ shell }: { shell: { openExternal: OpenExternal } }) => {
    const globals = globalThis as CaptureGlobals;
    const opened: string[] = [];
    const capture: OpenExternal = async (url) => {
      opened.push(url);
    };
    globals.trinityOpenedUrls = opened;
    globals.trinityRealOpenExternal = shell.openExternal;
    shell.openExternal = capture;
    if (shell.openExternal !== capture) {
      throw new Error('shell.openExternal could not be replaced');
    }
  });
  try {
    await page.getByRole('button', { name: 'Continue with SSO' }).click();

    const opened = () =>
      app.evaluate(
        () => (globalThis as CaptureGlobals).trinityOpenedUrls ?? [],
      );
    await expect.poll(async () => (await opened()).length).toBe(1);
    const [url] = await opened();
    // The capture records any external URL; prove it is this homeserver's SSO hand-off.
    const handoff = new URL(url);
    expect(`${handoff.origin}${handoff.pathname}`).toBe(
      `${homeserver.origin}/_matrix/client/v3/login/sso/redirect`,
    );
    expect(handoff.searchParams.get('redirectUrl')).toMatch(
      new RegExp(
        `^${expected.deepLinkScheme.replaceAll('.', '\\.')}://sso-callback\\?sso_state=[0-9a-f]{32}$`,
      ),
    );
  } finally {
    await app.evaluate(
      ({ shell }: { shell: { openExternal: OpenExternal } }) => {
        const real = (globalThis as CaptureGlobals).trinityRealOpenExternal;
        if (real) shell.openExternal = real;
      },
    );
  }
});
